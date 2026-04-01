import React, { useState, useEffect, useRef } from 'react';
import { fetchRepoTree, fetchFileContent } from '../services/github';
import { analyzeLogicUnit, translateToBusinessLogic, checkImplementationConflict, mapLogicsToModulesBulk, getEmbeddingsBulk, cosineSimilarity } from '../services/gemini';
import { parseCodeToNodes } from '../services/astParser';
import { db, auth } from '../firebase';
import { collection, addDoc, serverTimestamp, query, where, getDocs, doc, setDoc, updateDoc, arrayUnion, getDoc, deleteDoc, writeBatch } from 'firebase/firestore';
import { Note, SyncLedger, OperationType } from '../types';
import { handleFirestoreError, computeHash } from '../lib/utils';
import { Github, RefreshCw, AlertCircle, PanelRightClose, X, Trash2 } from 'lucide-react';

export const GitHubSync = ({ onClose, projectId }: { onClose: () => void, projectId: string | null }) => {
  const [repoUrl, setRepoUrl] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [isMapping, setIsMapping] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [logs, setLogs] = useState<{ msg: string, time: string }[]>([]);
  const cancelSyncRef = useRef(false);

  useEffect(() => {
    if (!projectId) return;
    const fetchProject = async () => {
      try {
        const docSnap = await getDoc(doc(db, 'projects', projectId));
        if (docSnap.exists() && docSnap.data().repoUrl) {
          setRepoUrl(docSnap.data().repoUrl);
        } else {
          setRepoUrl('');
        }
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `projects/${projectId}`);
      }
    };
    fetchProject();
  }, [projectId]);

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogs(prev => [...prev, { msg, time }]);
  };

  const handleSaveUrl = async () => {
    if (!projectId) return;
    try {
      await updateDoc(doc(db, 'projects', projectId), { repoUrl });
      addLog('Repository URL saved.');
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `projects/${projectId}`);
    }
  };

  const handleCancelSync = () => {
    cancelSyncRef.current = true;
    addLog('Cancelling sync... Please wait for the current file to finish.');
  };

  const executeReset = async () => {
    if (!projectId || !auth.currentUser) return;
    setResetting(true);
    setConfirmReset(false);
    addLog('Resetting snapshots and sync ledger...');
    try {
      // 1. Delete all Snapshot notes for this project
      const snapshotQuery = query(
        collection(db, 'notes'),
        where('uid', '==', auth.currentUser.uid),
        where('projectId', '==', projectId),
        where('noteType', '==', 'Snapshot')
      );
      const snapshotDocs = await getDocs(snapshotQuery);
      
      // Use batch for deletion
      let batch = writeBatch(db);
      let count = 0;
      for (const d of snapshotDocs.docs) {
        batch.delete(doc(db, 'notes', d.id));
        count++;
        if (count >= 450) {
          await batch.commit();
          batch = writeBatch(db);
          count = 0;
        }
      }
      if (count > 0) await batch.commit();
      
      addLog(`Deleted ${snapshotDocs.docs.length} snapshots.`);

      // 2. Reset Sync Ledger
      const ledgerQuery = query(
        collection(db, 'syncLedgers'),
        where('uid', '==', auth.currentUser.uid),
        where('projectId', '==', projectId)
      );
      const ledgerDocs = await getDocs(ledgerQuery);
      for (const ledgerDoc of ledgerDocs.docs) {
        await updateDoc(doc(db, 'syncLedgers', ledgerDoc.id), { fileShaMap: {} });
      }
      addLog('Sync ledger reset successfully.');
    } catch (error) {
      addLog(`Reset failed: ${error}`);
      handleFirestoreError(error, OperationType.DELETE, 'notes/snapshots');
    } finally {
      setResetting(false);
    }
  };

  const handleSync = async () => {
    if (!repoUrl || !auth.currentUser || !projectId) return;
    setSyncing(true);
    cancelSyncRef.current = false;
    setLogs([]);
    addLog(`Starting sync for ${repoUrl}...`);

    let batch = writeBatch(db);
    let batchCount = 0;

    const commitBatch = async () => {
      if (batchCount > 0) {
        try {
          addLog(`Committing batch of ${batchCount} operations...`);
          await batch.commit();
        } finally {
          // Always reset batch to avoid "batch already committed" errors even if commit fails
          batch = writeBatch(db);
          batchCount = 0;
        }
      }
    };

    try {
      // Update project repoUrl if changed
      await updateDoc(doc(db, 'projects', projectId), { repoUrl });

      // 1. Fetch Ledger
      const ledgerQuery = query(
        collection(db, 'syncLedgers'), 
        where('uid', '==', auth.currentUser.uid),
        where('projectId', '==', projectId)
      );
      const ledgerSnap = await getDocs(ledgerQuery);
      
      let ledger: Partial<SyncLedger> = { repoUrl, projectId, fileShaMap: {}, uid: auth.currentUser.uid };
      let ledgerId = '';

      const existingLedger = ledgerSnap.docs.find(doc => doc.data().repoUrl === repoUrl);
      if (existingLedger) {
        ledgerId = existingLedger.id;
        ledger = existingLedger.data() as SyncLedger;
      }

      // 2. Fetch Repo Tree
      addLog('Fetching repository tree...');
      const tree = await fetchRepoTree(repoUrl);
      
      const filesToProcess = tree.filter((item: any) => 
        item.type === 'blob' && 
        (item.path.endsWith('.ts') || item.path.endsWith('.tsx') || item.path.endsWith('.js') || item.path.endsWith('.jsx'))
      );

      addLog(`Found ${filesToProcess.length} source files.`);

      // Fetch all existing notes to build path hierarchy
      const allNotesQuery = query(
        collection(db, 'notes'),
        where('uid', '==', auth.currentUser.uid),
        where('projectId', '==', projectId)
      );
      const allNotesSnap = await getDocs(allNotesQuery);
      const allNotes = allNotesSnap.docs.map(d => ({ id: d.id, ...d.data() } as Note));

      // Pre-compute embeddings for existing Logic notes
      addLog('Pre-computing embeddings for existing Logic notes...');
      const existingLogicNotes = allNotes.filter(n => n.noteType === 'Logic');
      let existingLogicEmbeddings: number[][] = [];
      if (existingLogicNotes.length > 0) {
        existingLogicEmbeddings = await getEmbeddingsBulk(existingLogicNotes.map(n => `${n.title} ${n.summary}`));
      }

      const newShaMap = { ...ledger.fileShaMap };
      let processedCount = 0;

      const filesNeedingSync = filesToProcess.filter(file => !ledger.fileShaMap || ledger.fileShaMap[file.path] !== file.sha);
      addLog(`Selected ${filesNeedingSync.length} files for synchronization.`);

      for (const file of filesToProcess) {
        if (cancelSyncRef.current) {
          addLog('Sync stopped by user.');
          break;
        }

        if (ledger.fileShaMap && ledger.fileShaMap[file.path] === file.sha) {
          continue;
        }

        addLog(`Phase 0: Change detected in ${file.path}. Starting analysis...`);
        try {
          const content = await fetchFileContent(repoUrl, file.path);
          
          // Phase 1: Extract Logic Units (AST Parsing)
          addLog(`Phase 1: Extracting logic units from ${file.path} using AST...`);
          const logicUnits = parseCodeToNodes(file.path, content);
          await new Promise(resolve => setTimeout(resolve, 500)); // 0.5s delay
          
          const processedLogics: any[] = [];
          
          // Process logic units in batches of 5 (Phase 2 -> 3 -> 4)
          const BATCH_SIZE = 5;
          for (let i = 0; i < logicUnits.length; i += BATCH_SIZE) {
            if (cancelSyncRef.current) break;
            
            const batchUnits = logicUnits.slice(i, i + BATCH_SIZE);
            addLog(`Processing batch of ${batchUnits.length} logic units (Phase 2 ~ 4)...`);

            // Run AI analysis for the entire batch in parallel
            const batchResults = await Promise.all(batchUnits.map(async (unit: any) => {
              try {
                const normalizedCode = (unit.code || "").replace(/\s+/g, '');
                const unitHash = await computeHash(normalizedCode || (unit.title + content));
                const cachedNote = allNotes.find(n => n.noteType === 'Snapshot' && n.contentHash === unitHash && n.originPath === file.path);
                
                if (cachedNote) {
                  addLog(`Cache Hit: Skipping AI analysis for unchanged logic: ${unit.title} (Hash: ${unitHash.substring(0, 8)}...)`);
                  // We need to find the parent Logic note to pass it down
                  const parentLogic = allNotes.find(n => n.noteType === 'Logic' && n.childNoteIds.includes(cachedNote.id));
                  if (parentLogic) {
                    // We can reuse the existing Logic note's business logic
                    const businessLogic = {
                      title: parentLogic.title,
                      summary: parentLogic.summary,
                      components: parentLogic.components,
                      flow: parentLogic.flow,
                      io: parentLogic.io
                    };
                    const analysis = {
                      title: cachedNote.title,
                      summary: cachedNote.summary,
                      components: cachedNote.components,
                      flow: cachedNote.flow,
                      io: cachedNote.io
                    };
                    
                    // We still need logicAEmbedding for Phase 4 mapping if we want to re-map, 
                    // but since it's a cache hit, it's already mapped. We can just return case 4-1 directly.
                    return { 
                      unit, 
                      analysis, 
                      businessLogic, 
                      unitHash, 
                      caseType: '4-1', 
                      targetLogicB: parentLogic, 
                      targetSnapshotB: cachedNote, 
                      isConflict: parentLogic.status === 'Conflict', 
                      conflictDetails: parentLogic.conflictDetails, 
                      logicAEmbedding: null 
                    };
                  }
                }

                addLog(`Phase 2: AI Deep Analysis (IPO Model) for: ${unit.title}`);
                const analysis = await analyzeLogicUnit(unit.title, unit.code);
                
                addLog(`Phase 3: Generating Business Logic for: ${unit.title}`);
                const businessLogic = await translateToBusinessLogic({ title: unit.title, ...analysis });
                
                addLog(`Phase 4: Vector Search Mapping for: ${unit.title}`);
                const logicText = `${businessLogic.title} ${businessLogic.summary}`;
                const [logicAEmbedding] = await getEmbeddingsBulk([logicText]);
                
                let bestMatchLogicB = null;
                let highestSimilarity = -1;

                for (let j = 0; j < existingLogicNotes.length; j++) {
                  const sim = cosineSimilarity(logicAEmbedding, existingLogicEmbeddings[j]);
                  if (sim > highestSimilarity) {
                    highestSimilarity = sim;
                    bestMatchLogicB = existingLogicNotes[j];
                  }
                }

                const SIMILARITY_THRESHOLD = 0.75; // Adjust as needed
                let caseType = '4-3';
                let targetLogicB = null;
                let targetSnapshotB = null;
                let isConflict = false;
                let conflictDetails = undefined;

                if (bestMatchLogicB && highestSimilarity >= SIMILARITY_THRESHOLD) {
                  const childSnapshots = allNotes.filter(n => n.noteType === 'Snapshot' && bestMatchLogicB.childNoteIds.includes(n.id));
                  
                  if (childSnapshots.length > 0) {
                    // Case 4-1: 단순 업데이트 (이미 연결된 스냅샷이 있는 경우)
                    caseType = '4-1';
                    targetLogicB = bestMatchLogicB;
                    // Prefer the snapshot from the same path if multiple exist, otherwise just take the first one
                    targetSnapshotB = childSnapshots.find(s => s.originPath === file.path) || childSnapshots[0];
                  } else {
                    // Case 4-2: 설계-코드 최초 연결 (연결된 스냅샷이 없는 경우)
                    caseType = '4-2';
                    targetLogicB = bestMatchLogicB;
                  }
                  
                  // Conflict Check for both 4-1 and 4-2
                  const conflictResult = await checkImplementationConflict(businessLogic, targetLogicB);
                  isConflict = conflictResult.isConflict;
                  conflictDetails = conflictResult.conflictDetails;
                }

                return { unit, analysis, businessLogic, unitHash, caseType, targetLogicB, targetSnapshotB, isConflict, conflictDetails, logicAEmbedding };
              } catch (err) {
                addLog(`Error analyzing ${unit.title}: ${err}`);
                return null;
              }
            }));

            processedLogics.push(...batchResults.filter(Boolean));
            await new Promise(resolve => setTimeout(resolve, 500));
          }

          if (cancelSyncRef.current) break;

          // Phase 5: Tree Assembly & Persistence
          addLog(`Phase 5: Tree Assembly & Persistence...`);
          for (const result of processedLogics) {
            if (cancelSyncRef.current) break;
            
            const { unit, analysis, businessLogic, unitHash, caseType, targetLogicB, targetSnapshotB, isConflict, conflictDetails, logicAEmbedding } = result;

            const snapshotRef = targetSnapshotB ? doc(db, 'notes', targetSnapshotB.id) : doc(collection(db, 'notes'));
            const snapshotId = targetSnapshotB ? targetSnapshotB.id : snapshotRef.id;
            
            if (caseType === '4-1') {
              // Update existing Snapshot B and Logic B
              addLog(`Case 4-1: Updating existing Logic & Snapshot for ${unit.title} (Conflict: ${isConflict})`);
              
              const logicRef = doc(db, 'notes', targetLogicB.id);
              
              const logicUpdates: any = {
                status: isConflict ? 'Conflict' : 'Done',
                lastUpdated: serverTimestamp(),
                ...(conflictDetails ? { conflictDetails } : {}),
                ...(unitHash ? { contentHash: unitHash } : {})
              };

              if (!isConflict) {
                // Only update content if there is no conflict
                logicUpdates.title = businessLogic.title.substring(0, 200);
                logicUpdates.summary = businessLogic.summary;
                logicUpdates.components = businessLogic.components;
                logicUpdates.flow = businessLogic.flow;
                logicUpdates.io = businessLogic.io;
                logicUpdates.conflictDetails = null; // Clear any previous conflict
              }

              batch.update(logicRef, logicUpdates);
              batchCount++;
              
              batch.update(snapshotRef, {
                title: analysis.title.substring(0, 200),
                summary: analysis.summary,
                components: analysis.components,
                flow: analysis.flow,
                io: analysis.io,
                body: unit.code,
                sha: file.sha,
                lastUpdated: serverTimestamp(),
                ...(unitHash ? { contentHash: unitHash } : {})
              });
              batchCount++;
              
            } else if (caseType === '4-2') {
              // Link Snapshot A to empty Logic B
              addLog(`Case 4-2: Linking new Snapshot to empty Logic for ${unit.title} (Conflict: ${isConflict})`);
              
              const logicRef = doc(db, 'notes', targetLogicB.id);
              
              const logicUpdates: any = {
                childNoteIds: arrayUnion(snapshotId),
                status: isConflict ? 'Conflict' : 'Done',
                lastUpdated: serverTimestamp(),
                ...(conflictDetails ? { conflictDetails } : {}),
                ...(unitHash ? { contentHash: unitHash } : {})
              };

              if (!isConflict) {
                logicUpdates.conflictDetails = null;
              }

              batch.update(logicRef, logicUpdates);
              batchCount++;
              
              const snapshotData: Partial<Note> = {
                id: snapshotId,
                title: analysis.title.substring(0, 200),
                projectId,
                summary: analysis.summary || '',
                components: analysis.components || null,
                flow: analysis.flow || null,
                io: analysis.io || null,
                body: '',
                folder: file.path,
                noteType: 'Snapshot',
                status: 'Done',
                priority: 'Done',
                parentNoteIds: [targetLogicB.id],
                childNoteIds: [],
                relatedNoteIds: [],
                originPath: file.path,
                sha: file.sha,
                uid: auth.currentUser.uid,
                lastUpdated: serverTimestamp()
              };
              batch.set(snapshotRef, snapshotData);
              batchCount++;
              allNotes.push(snapshotData as Note);
              
            } else if (caseType === '4-3') {
              // Create new Logic A and Snapshot A
              addLog(`Case 4-3: Creating new Logic & Snapshot for ${unit.title}`);
              
              const logicRef = doc(collection(db, 'notes'));
              const logicId = logicRef.id;
              
              const logicData: Partial<Note> = {
                id: logicId,
                title: businessLogic.title.substring(0, 200),
                projectId,
                summary: businessLogic.summary || '',
                components: businessLogic.components || null,
                flow: businessLogic.flow || null,
                io: businessLogic.io || null,
                body: '',
                folder: file.path,
                noteType: 'Logic',
                status: 'Planned',
                priority: 'C',
                parentNoteIds: [],
                childNoteIds: [snapshotId],
                relatedNoteIds: [],
                uid: auth.currentUser.uid,
                lastUpdated: serverTimestamp(),
                ...(unitHash ? { contentHash: unitHash } : {})
              };
              batch.set(logicRef, logicData);
              batchCount++;
              
              const snapshotData: Partial<Note> = {
                id: snapshotId,
                title: analysis.title.substring(0, 200),
                projectId,
                summary: analysis.summary || '',
                components: analysis.components || null,
                flow: analysis.flow || null,
                io: analysis.io || null,
                body: '',
                folder: file.path,
                noteType: 'Snapshot',
                status: 'Done',
                priority: 'Done',
                parentNoteIds: [logicId],
                childNoteIds: [],
                relatedNoteIds: [],
                originPath: file.path,
                sha: file.sha,
                uid: auth.currentUser.uid,
                lastUpdated: serverTimestamp()
              };
              batch.set(snapshotRef, snapshotData);
              batchCount++;
              
              allNotes.push(logicData as Note);
              allNotes.push(snapshotData as Note);
              existingLogicNotes.push(logicData as Note);
              existingLogicEmbeddings.push(logicAEmbedding);
            }
            
            if (batchCount >= 450) await commitBatch();
          }

          if (!cancelSyncRef.current) {
            newShaMap[file.path] = file.sha;
            processedCount++;
          }
          
          // Commit batch after each file to show progress immediately in Explorer
          await commitBatch();
        } catch (err) {
          addLog(`Error processing ${file.path}: ${err}`);
        }
      }

      // Final commit for notes
      await commitBatch();

      // 3. Update Ledger
      addLog('Updating sync ledger...');
      const { id: _, ...ledgerBase } = ledger;
      const ledgerData = {
        ...ledgerBase,
        fileShaMap: newShaMap,
        lastSyncedAt: serverTimestamp()
      };

      if (ledgerId) {
        await setDoc(doc(db, 'syncLedgers', ledgerId), ledgerData);
      } else {
        await addDoc(collection(db, 'syncLedgers'), ledgerData);
      }

      addLog(`Sync complete! Processed ${processedCount} files.`);
    } catch (error) {
      addLog(`Sync failed: ${error}`);
      handleFirestoreError(error, OperationType.WRITE, 'syncLedgers');
    } finally {
      setSyncing(false);
    }
  };

  const handleModuleMapping = async () => {
    if (!auth.currentUser || !projectId) return;
    setIsMapping(true);
    cancelSyncRef.current = false;
    setLogs([]);
    addLog(`Starting Auto-Map Modules...`);

    let batch = writeBatch(db);
    let batchCount = 0;

    const commitBatch = async () => {
      if (batchCount > 0) {
        try {
          addLog(`Committing batch of ${batchCount} operations...`);
          await batch.commit();
        } finally {
          batch = writeBatch(db);
          batchCount = 0;
        }
      }
    };

    try {
      // Fetch all unassigned Logic notes
      const unassignedLogicsQuery = query(
        collection(db, 'notes'),
        where('uid', '==', auth.currentUser.uid),
        where('projectId', '==', projectId),
        where('noteType', '==', 'Logic'),
        where('parentNoteIds', '==', [])
      );
      const unassignedLogicsSnap = await getDocs(unassignedLogicsQuery);
      const unassignedLogics = unassignedLogicsSnap.docs.map(d => ({ id: d.id, ...d.data() } as Note));

      if (unassignedLogics.length === 0) {
        addLog('No unassigned Logic notes found. Everything is mapped!');
        setIsMapping(false);
        return;
      }
      addLog(`Found ${unassignedLogics.length} unassigned Logic notes.`);

      // Fetch existing Module notes
      const existingModulesQuery = query(
        collection(db, 'notes'),
        where('uid', '==', auth.currentUser.uid),
        where('projectId', '==', projectId),
        where('noteType', '==', 'Module')
      );
      const existingModulesSnap = await getDocs(existingModulesQuery);
      const existingModules = existingModulesSnap.docs.map(d => ({ id: d.id, ...d.data() } as Note));

      let moduleEmbeddings: number[][] = [];
      if (existingModules.length > 0) {
        addLog(`Generating embeddings for ${existingModules.length} existing modules...`);
        moduleEmbeddings = await getEmbeddingsBulk(existingModules.map(m => `${m.title} ${m.summary}`));
      }

      const CHUNK_SIZE = 20;
      for (let i = 0; i < unassignedLogics.length; i += CHUNK_SIZE) {
        if (cancelSyncRef.current) {
          addLog('Mapping stopped by user.');
          break;
        }

        const chunk = unassignedLogics.slice(i, i + CHUNK_SIZE);
        addLog(`Processing Module Mapping Chunk (${i + 1} ~ ${i + chunk.length})...`);

        const logicTexts = chunk.map(logic => `${logic.title} ${logic.summary}`);
        
        let logicEmbeddings: number[][] = [];
        if (existingModules.length > 0) {
          logicEmbeddings = await getEmbeddingsBulk(logicTexts);
        }

        const logicsWithCandidates = chunk.map((logic, idx) => {
          let candidateModules: any[] = [];
          
          if (existingModules.length > 0) {
            const logicEmb = logicEmbeddings[idx];
            if (logicEmb && logicEmb.length > 0) {
              const similarities = existingModules.map((mod, modIdx) => ({
                module: mod,
                score: cosineSimilarity(logicEmb, moduleEmbeddings[modIdx] || [])
              }));
              similarities.sort((a, b) => b.score - a.score);
              candidateModules = similarities.slice(0, 5).map(s => ({
                id: s.module.id,
                title: s.module.title,
                summary: s.module.summary
              }));
            } else {
              candidateModules = existingModules.slice(0, 5).map(m => ({ id: m.id, title: m.title, summary: m.summary }));
            }
          }

          return {
            index: idx,
            title: logic.title,
            summary: logic.summary,
            candidateModules
          };
        });

        const bulkMappingResults = await mapLogicsToModulesBulk(logicsWithCandidates);
        const newModulesCreatedInChunk: Record<string, any> = {};

        for (const mapping of bulkMappingResults) {
          const logic = chunk[mapping.index];
          if (!logic) continue;

          let moduleId = mapping.mappedModuleId;
          let isNew = false;
          let newModuleData = null;

          if (!moduleId && mapping.suggestedTitle) {
            if (newModulesCreatedInChunk[mapping.suggestedTitle]) {
              moduleId = newModulesCreatedInChunk[mapping.suggestedTitle].id;
            } else {
              const moduleRef = doc(collection(db, 'notes'));
              moduleId = moduleRef.id;
              newModuleData = {
                id: moduleId,
                title: mapping.suggestedTitle.substring(0, 200),
                projectId,
                summary: mapping.suggestedSummary || '',
                body: '',
                folder: logic.folder || '',
                noteType: 'Module',
                status: 'Planned',
                priority: 'C',
                parentNoteIds: [],
                childNoteIds: [],
                relatedNoteIds: [],
                uid: auth.currentUser.uid,
                lastUpdated: serverTimestamp()
              };
              existingModules.push(newModuleData as Note);
              newModulesCreatedInChunk[mapping.suggestedTitle] = newModuleData;
              isNew = true;
              addLog(`Proposed new Module: ${newModuleData.title}`);
              
              // Generate embedding for the new module so the next chunk can match it
              const newEmb = await getEmbeddingsBulk([`${newModuleData.title} ${newModuleData.summary}`]);
              moduleEmbeddings.push(newEmb[0] || []);
            }
          }

          if (isNew && newModuleData) {
            const moduleRef = doc(db, 'notes', newModuleData.id);
            batch.set(moduleRef, newModuleData);
            batchCount++;
            if (batchCount >= 450) await commitBatch();
          }

          if (moduleId) {
            // Update Logic Note
            const logicRef = doc(db, 'notes', logic.id);
            batch.update(logicRef, {
              parentNoteIds: arrayUnion(moduleId),
              lastUpdated: serverTimestamp()
            });
            batchCount++;
            if (batchCount >= 450) await commitBatch();

            // Update Module Note
            const moduleRef = doc(db, 'notes', moduleId);
            batch.update(moduleRef, {
              childNoteIds: arrayUnion(logic.id),
              lastUpdated: serverTimestamp()
            });
            batchCount++;
            if (batchCount >= 450) await commitBatch();
          }
        }
        await commitBatch();
      }

      await commitBatch();
      addLog(`Auto-Map Modules complete!`);
    } catch (error) {
      addLog(`Auto-Map failed: ${error}`);
      handleFirestoreError(error, OperationType.UPDATE, 'notes');
    } finally {
      setIsMapping(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-card/95 backdrop-blur-2xl border-l border-border glass shadow-2xl animate-in slide-in-from-right duration-500">
      <div className="p-8 border-b border-border flex justify-between items-center bg-muted/5">
        <div>
          <h2 className="font-black text-foreground flex items-center gap-3 uppercase tracking-[0.3em] text-xs italic">
            <Github size={20} className="text-primary glow-primary" /> Sync Engine
          </h2>
          <p className="text-[10px] font-bold text-muted-foreground/40 uppercase tracking-widest mt-1">Repository Architect</p>
        </div>
        <button 
          onClick={onClose} 
          className="p-2.5 text-muted-foreground hover:bg-muted rounded-xl transition-all active:scale-95 border border-transparent hover:border-border/50" 
          title="Close Engine"
        >
          <X size={20} />
        </button>
      </div>
      
      <div className="p-8 flex flex-col h-full overflow-hidden space-y-8">
        <div className="space-y-6">
          <div className="space-y-3">
            <label className="text-[10px] font-black text-muted-foreground uppercase tracking-[0.2em] ml-1">Source Repository</label>
            <div className="flex gap-3">
              <input 
                type="text" 
                placeholder="https://github.com/owner/repo"
                value={repoUrl}
                onChange={e => setRepoUrl(e.target.value)}
                className="flex-1 p-4 bg-background/50 border border-border rounded-2xl focus:ring-2 focus:ring-primary/20 outline-none text-xs font-mono"
              />
              <button 
                onClick={handleSaveUrl}
                disabled={syncing}
                className="px-6 py-2 bg-muted text-muted-foreground rounded-2xl hover:bg-muted/80 disabled:opacity-50 text-[10px] font-black uppercase tracking-widest transition-all border border-border/50"
              >
                Save
              </button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            {syncing || isMapping ? (
              <button 
                onClick={handleCancelSync}
                className="flex justify-center items-center gap-3 px-4 py-4 bg-destructive text-destructive-foreground rounded-2xl hover:opacity-90 text-[10px] font-black uppercase tracking-[0.2em] shadow-xl shadow-destructive/20 transition-all active:scale-95"
              >
                <X size={18} /> Abort
              </button>
            ) : (
              <button 
                onClick={handleSync}
                disabled={!repoUrl || resetting}
                className="flex justify-center items-center gap-3 px-4 py-4 bg-primary text-primary-foreground rounded-2xl hover:opacity-90 disabled:opacity-50 text-[10px] font-black uppercase tracking-[0.2em] shadow-xl shadow-primary/20 transition-all active:scale-95 glow-primary"
              >
                <RefreshCw size={18} className={syncing ? 'animate-spin' : ''} /> Sync
              </button>
            )}

            <button 
              onClick={handleModuleMapping}
              disabled={syncing || resetting || isMapping}
              className="flex justify-center items-center gap-3 px-4 py-4 bg-secondary text-secondary-foreground rounded-2xl hover:opacity-90 disabled:opacity-50 text-[10px] font-black uppercase tracking-[0.2em] shadow-xl shadow-secondary/20 transition-all active:scale-95"
            >
              <RefreshCw size={18} className={isMapping ? 'animate-spin' : ''} /> {isMapping ? 'Mapping...' : 'Auto-Map'}
            </button>
            
            <button 
              onClick={() => confirmReset ? executeReset() : setConfirmReset(true)}
              disabled={syncing || resetting || isMapping}
              className={`flex justify-center items-center gap-3 px-4 py-4 rounded-2xl text-[10px] font-black uppercase tracking-[0.2em] transition-all active:scale-95 border ${
                confirmReset 
                  ? 'bg-destructive text-destructive-foreground shadow-xl shadow-destructive/20 border-transparent' 
                  : 'bg-muted/30 text-muted-foreground hover:bg-destructive/10 hover:text-destructive border-border/50'
              } disabled:opacity-50`}
            >
              <Trash2 size={18} /> {confirmReset ? 'Confirm' : 'Reset'}
            </button>
          </div>
        </div>

        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex justify-between items-center mb-3 ml-1">
            <label className="text-[10px] font-black text-muted-foreground uppercase tracking-[0.2em]">System Logs</label>
            <span className="text-[8px] font-mono text-muted-foreground/40 uppercase tracking-widest">Live Stream</span>
          </div>
          <div className="flex-1 bg-background/30 border border-border rounded-3xl p-6 overflow-y-auto font-mono text-[10px] text-foreground/60 custom-scrollbar shadow-inner relative">
            {logs.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground/20 italic gap-4">
                <div className="w-12 h-12 rounded-2xl border-2 border-dashed border-muted-foreground/10 flex items-center justify-center">
                  <AlertCircle size={24} />
                </div>
                <span>System standby. Awaiting commands.</span>
              </div>
            ) : (
              <div className="space-y-2">
                {logs.map((log, i) => (
                  <div key={i} className="flex gap-3 animate-in fade-in slide-in-from-left-2 duration-300">
                    <span className="text-primary/30 shrink-0 font-bold">[{log.time}]</span>
                    <span className="leading-relaxed">{log.msg}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
