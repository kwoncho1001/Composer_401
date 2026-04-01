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
        const textsToEmbed: string[] = [];
        const indicesToEmbed: number[] = [];
        
        existingLogicEmbeddings = new Array(existingLogicNotes.length).fill([]);
        
        existingLogicNotes.forEach((n, idx) => {
          const text = `${n.title} ${n.summary}`;
          if (n.embedding && n.embedding.length > 0) {
            existingLogicEmbeddings[idx] = n.embedding;
          } else {
            textsToEmbed.push(text);
            indicesToEmbed.push(idx);
          }
        });

        if (textsToEmbed.length > 0) {
          addLog(`Calculating missing embeddings for ${textsToEmbed.length} existing Logic notes...`);
          const newEmbeddings = await getEmbeddingsBulk(textsToEmbed);
          newEmbeddings.forEach((emb, i) => {
            const originalIdx = indicesToEmbed[i];
            existingLogicEmbeddings[originalIdx] = emb;
            
            // We should ideally save this back to Firestore, but for now we just use it in memory
            // to avoid slowing down the initial sync setup too much. It will be saved if the note is updated.
          });
        }
      }

      const newShaMap = { ...ledger.fileShaMap };
      let processedCount = 0;

      const filesNeedingSync = filesToProcess.filter((file: any) => !ledger.fileShaMap || ledger.fileShaMap[file.path] !== file.sha);
      addLog(`Phase 0: Selected ${filesNeedingSync.length} files for synchronization.`);

      if (filesNeedingSync.length === 0) {
        addLog('No files need synchronization.');
        setSyncing(false);
        return;
      }

      // Phase 1: Extract Logic Units (AST Parsing)
      addLog(`Phase 1: Extracting logic units from all changed files using AST...`);
      const allLogicUnits: any[] = [];
      for (const file of filesNeedingSync) {
        if (cancelSyncRef.current) break;
        try {
          const content = await fetchFileContent(repoUrl, file.path);
          const logicUnits = parseCodeToNodes(file.path, content);
          for (const unit of logicUnits) {
            const normalizedCode = (unit.code || "").replace(/\s+/g, '');
            const unitHash = await computeHash(normalizedCode || (unit.title + content));
            allLogicUnits.push({ unit, file, content, unitHash });
          }
        } catch (err) {
          addLog(`Error extracting logic units from ${file.path}: ${err}`);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (cancelSyncRef.current) {
        addLog('Sync stopped by user.');
        setSyncing(false);
        return;
      }

      // Phase 2: AI Deep Analysis (IPO Model)
      addLog(`Phase 2: AI Deep Analysis (IPO Model) for ${allLogicUnits.length} logic units...`);
      const BATCH_SIZE = 3;
      for (let i = 0; i < allLogicUnits.length; i += BATCH_SIZE) {
        if (cancelSyncRef.current) break;
        const batchUnits = allLogicUnits.slice(i, i + BATCH_SIZE);
        addLog(`Phase 2: Processing batch ${Math.floor(i/BATCH_SIZE) + 1} of ${Math.ceil(allLogicUnits.length/BATCH_SIZE)}...`);

        await Promise.all(batchUnits.map(async (item) => {
          const { unit, file, unitHash } = item;
          const cachedNote = allNotes.find(n => n.noteType === 'Snapshot' && n.contentHash === unitHash && n.originPath === file.path);
          
          if (cachedNote) {
            addLog(`Cache Hit: Skipping AI analysis for unchanged logic: ${unit.title} (Hash: ${unitHash.substring(0, 8)}...)`);
            const parentLogic = allNotes.find(n => n.noteType === 'Logic' && n.childNoteIds.includes(cachedNote.id));
            if (parentLogic) {
              item.isCacheHit = true;
              item.cachedNote = cachedNote;
              item.parentLogic = parentLogic;
              item.businessLogic = {
                title: parentLogic.title,
                summary: parentLogic.summary,
                components: parentLogic.components,
                flow: parentLogic.flow,
                io: parentLogic.io
              };
              item.analysis = {
                title: cachedNote.title,
                summary: cachedNote.summary,
                components: cachedNote.components,
                flow: cachedNote.flow,
                io: cachedNote.io
              };
              item.caseType = '4-1';
              item.targetLogicB = parentLogic;
              item.targetSnapshotB = cachedNote;
              item.isConflict = parentLogic.status === 'Conflict';
              item.conflictDetails = parentLogic.conflictDetails;
              item.logicAEmbedding = null;
              item.logicHash = parentLogic.embeddingHash || null;
            }
          }

          if (!item.isCacheHit) {
            try {
              addLog(`Phase 2: Analyzing: ${unit.title}`);
              item.analysis = await analyzeLogicUnit(unit.title, unit.code);
            } catch (err) {
              addLog(`Error analyzing ${unit.title}: ${err}`);
              item.error = true;
            }
          }
        }));
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      if (cancelSyncRef.current) {
        addLog('Sync stopped by user.');
        setSyncing(false);
        return;
      }

      // Phase 3: Generating Business Logic
      addLog(`Phase 3: Generating Business Logic for logic units...`);
      for (let i = 0; i < allLogicUnits.length; i += BATCH_SIZE) {
        if (cancelSyncRef.current) break;
        const batchUnits = allLogicUnits.slice(i, i + BATCH_SIZE).filter(item => !item.isCacheHit && !item.error);
        
        if (batchUnits.length > 0) {
          addLog(`Phase 3: Processing batch ${Math.floor(i/BATCH_SIZE) + 1} of ${Math.ceil(allLogicUnits.length/BATCH_SIZE)}...`);
          await Promise.all(batchUnits.map(async (item) => {
            try {
              addLog(`Phase 3: Translating: ${item.unit.title}`);
              item.businessLogic = await translateToBusinessLogic({ title: item.unit.title, ...item.analysis });
            } catch (err) {
              addLog(`Error translating ${item.unit.title}: ${err}`);
              item.error = true;
            }
          }));
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      if (cancelSyncRef.current) {
        addLog('Sync stopped by user.');
        setSyncing(false);
        return;
      }

      // Phase 4: Vector Search Mapping
      addLog(`Phase 4: Vector Search Mapping for logic units...`);
      
      // Bulk Embedding Calculation
      const unitsToEmbed = allLogicUnits.filter(item => !item.isCacheHit && !item.error);
      const textsToEmbed: string[] = [];
      const indicesToEmbed: number[] = [];
      
      for (let i = 0; i < unitsToEmbed.length; i++) {
        const item = unitsToEmbed[i];
        const logicText = `${item.businessLogic.title} ${item.businessLogic.summary}`;
        const logicHash = await computeHash(logicText);
        item.logicHash = logicHash;
        
        const existingLogicWithSameHash = allNotes.find(n => n.noteType === 'Logic' && n.embeddingHash === logicHash && n.embedding && n.embedding.length > 0);
        
        if (existingLogicWithSameHash && existingLogicWithSameHash.embedding) {
          addLog(`Reusing existing embedding for: ${item.unit.title}`);
          item.logicAEmbedding = existingLogicWithSameHash.embedding;
        } else {
          textsToEmbed.push(logicText);
          indicesToEmbed.push(i);
        }
      }

      if (textsToEmbed.length > 0) {
        addLog(`Phase 4: Calculating embeddings in bulk for ${textsToEmbed.length} logic units...`);
        const EMBED_CHUNK_SIZE = 20;
        for (let i = 0; i < textsToEmbed.length; i += EMBED_CHUNK_SIZE) {
          if (cancelSyncRef.current) break;
          const chunkTexts = textsToEmbed.slice(i, i + EMBED_CHUNK_SIZE);
          const chunkIndices = indicesToEmbed.slice(i, i + EMBED_CHUNK_SIZE);
          try {
            const newEmbeddings = await getEmbeddingsBulk(chunkTexts);
            newEmbeddings.forEach((emb, idx) => {
              const originalIdx = chunkIndices[idx];
              unitsToEmbed[originalIdx].logicAEmbedding = emb;
            });
          } catch (err) {
            addLog(`Error calculating embeddings: ${err}`);
            chunkIndices.forEach(idx => {
               unitsToEmbed[idx].error = true;
            });
          }
        }
      }

      if (cancelSyncRef.current) {
        addLog('Sync stopped by user.');
        setSyncing(false);
        return;
      }

      // Similarity matching and conflict detection
      addLog(`Phase 4: Matching logic units to existing notes...`);
      for (let i = 0; i < unitsToEmbed.length; i += BATCH_SIZE) {
        if (cancelSyncRef.current) break;
        const batchUnits = unitsToEmbed.slice(i, i + BATCH_SIZE).filter(item => !item.error && item.logicAEmbedding);
        
        if (batchUnits.length > 0) {
          await Promise.all(batchUnits.map(async (item) => {
            let bestMatchLogicB = null;
            let highestSimilarity = -1;

            for (let j = 0; j < existingLogicNotes.length; j++) {
              const sim = cosineSimilarity(item.logicAEmbedding, existingLogicEmbeddings[j]);
              if (sim > highestSimilarity) {
                highestSimilarity = sim;
                bestMatchLogicB = existingLogicNotes[j];
              }
            }

            const SIMILARITY_THRESHOLD = 0.75;
            item.caseType = '4-3';
            item.targetLogicB = null;
            item.targetSnapshotB = null;
            item.isConflict = false;
            item.conflictDetails = undefined;

            if (bestMatchLogicB && highestSimilarity >= SIMILARITY_THRESHOLD) {
              const childSnapshots = allNotes.filter(n => n.noteType === 'Snapshot' && bestMatchLogicB.childNoteIds.includes(n.id));
              
              if (childSnapshots.length > 0) {
                item.caseType = '4-1';
                item.targetLogicB = bestMatchLogicB;
                item.targetSnapshotB = childSnapshots.find(s => s.originPath === item.file.path) || childSnapshots[0];
              } else {
                item.caseType = '4-2';
                item.targetLogicB = bestMatchLogicB;
              }
              
              try {
                const conflictResult = await checkImplementationConflict(item.businessLogic, item.targetLogicB);
                item.isConflict = conflictResult.isConflict;
                item.conflictDetails = conflictResult.conflictDetails;
              } catch (err) {
                addLog(`Error checking conflict for ${item.unit.title}: ${err}`);
              }
            }
          }));
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      if (cancelSyncRef.current) {
        addLog('Sync stopped by user.');
        setSyncing(false);
        return;
      }

      // Phase 5: Tree Assembly & Persistence
      addLog(`Phase 5: Tree Assembly & Persistence...`);
      
      const unitsByFile = new Map<string, any[]>();
      for (const item of allLogicUnits) {
        if (item.error) continue;
        const path = item.file.path;
        if (!unitsByFile.has(path)) {
          unitsByFile.set(path, []);
        }
        unitsByFile.get(path)!.push(item);
      }

      for (const file of filesNeedingSync) {
        if (cancelSyncRef.current) break;
        
        const fileUnits = unitsByFile.get(file.path) || [];
        
        for (const result of fileUnits) {
          const { unit, file: currentFile, analysis, businessLogic, unitHash, caseType, targetLogicB, targetSnapshotB, isConflict, conflictDetails, logicAEmbedding, logicHash } = result;

          const snapshotRef = targetSnapshotB ? doc(db, 'notes', targetSnapshotB.id) : doc(collection(db, 'notes'));
          const snapshotId = targetSnapshotB ? targetSnapshotB.id : snapshotRef.id;
          
          if (caseType === '4-1') {
            addLog(`Case 4-1: Updating existing Logic & Snapshot for ${unit.title} (Conflict: ${isConflict})`);
            
            const logicRef = doc(db, 'notes', targetLogicB.id);
            
            const logicUpdates: any = {
              status: isConflict ? 'Conflict' : 'Done',
              lastUpdated: serverTimestamp(),
              ...(conflictDetails ? { conflictDetails } : {}),
              ...(unitHash ? { contentHash: unitHash } : {}),
              ...(logicAEmbedding ? { embedding: logicAEmbedding } : {}),
              ...(logicHash ? { embeddingHash: logicHash } : {}),
              embeddingModel: 'gemini-embedding-2-preview',
              lastEmbeddedAt: serverTimestamp()
            };

            if (!isConflict && !result.isCacheHit) {
              logicUpdates.title = businessLogic.title.substring(0, 200);
              logicUpdates.summary = businessLogic.summary;
              logicUpdates.components = businessLogic.components;
              logicUpdates.flow = businessLogic.flow;
              logicUpdates.io = businessLogic.io;
              logicUpdates.conflictDetails = null;
            }

            batch.update(logicRef, logicUpdates);
            batchCount++;
            
            const snapshotUpdates: any = {
              lastUpdated: serverTimestamp(),
              sha: currentFile.sha,
              ...(unitHash ? { contentHash: unitHash } : {})
            };
            
            if (!result.isCacheHit) {
              snapshotUpdates.title = analysis.title.substring(0, 200);
              snapshotUpdates.summary = analysis.summary;
              snapshotUpdates.components = analysis.components;
              snapshotUpdates.flow = analysis.flow;
              snapshotUpdates.io = analysis.io;
              snapshotUpdates.body = unit.code;
            }

            batch.update(snapshotRef, snapshotUpdates);
            batchCount++;
            
          } else if (caseType === '4-2') {
            addLog(`Case 4-2: Linking new Snapshot to empty Logic for ${unit.title} (Conflict: ${isConflict})`);
            
            const logicRef = doc(db, 'notes', targetLogicB.id);
            
            const logicUpdates: any = {
              childNoteIds: arrayUnion(snapshotId),
              status: isConflict ? 'Conflict' : 'Done',
              lastUpdated: serverTimestamp(),
              ...(conflictDetails ? { conflictDetails } : {}),
              ...(unitHash ? { contentHash: unitHash } : {}),
              ...(logicAEmbedding ? { embedding: logicAEmbedding } : {}),
              ...(logicHash ? { embeddingHash: logicHash } : {}),
              embeddingModel: 'gemini-embedding-2-preview',
              lastEmbeddedAt: serverTimestamp()
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
              body: unit.code || '',
              folder: currentFile.path,
              noteType: 'Snapshot',
              status: 'Done',
              priority: 'Done',
              parentNoteIds: [targetLogicB.id],
              childNoteIds: [],
              relatedNoteIds: [],
              originPath: currentFile.path,
              sha: currentFile.sha,
              uid: auth.currentUser.uid,
              lastUpdated: serverTimestamp(),
              ...(unitHash ? { contentHash: unitHash } : {})
            };
            batch.set(snapshotRef, snapshotData);
            batchCount++;
            allNotes.push(snapshotData as Note);
            
          } else if (caseType === '4-3') {
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
              folder: currentFile.path,
              noteType: 'Logic',
              status: 'Planned',
              priority: 'C',
              parentNoteIds: [],
              childNoteIds: [snapshotId],
              relatedNoteIds: [],
              uid: auth.currentUser.uid,
              lastUpdated: serverTimestamp(),
              ...(unitHash ? { contentHash: unitHash } : {}),
              ...(logicAEmbedding ? { embedding: logicAEmbedding } : {}),
              ...(logicHash ? { embeddingHash: logicHash } : {}),
              embeddingModel: 'gemini-embedding-2-preview',
              lastEmbeddedAt: serverTimestamp()
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
              body: unit.code || '',
              folder: currentFile.path,
              noteType: 'Snapshot',
              status: 'Done',
              priority: 'Done',
              parentNoteIds: [logicId],
              childNoteIds: [],
              relatedNoteIds: [],
              originPath: currentFile.path,
              sha: currentFile.sha,
              uid: auth.currentUser.uid,
              lastUpdated: serverTimestamp(),
              ...(unitHash ? { contentHash: unitHash } : {})
            };
            batch.set(snapshotRef, snapshotData);
            batchCount++;
            
            allNotes.push(logicData as Note);
            allNotes.push(snapshotData as Note);
            existingLogicNotes.push(logicData as Note);
            if (logicAEmbedding) {
              existingLogicEmbeddings.push(logicAEmbedding);
            }
          }
          
          if (batchCount >= 450) await commitBatch();
        }

        if (!cancelSyncRef.current) {
          newShaMap[file.path] = file.sha;
          processedCount++;
        }
        
        await commitBatch();
      }

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
        addLog(`Preparing embeddings for ${existingModules.length} existing modules...`);
        const textsToEmbed: string[] = [];
        const indicesToEmbed: number[] = [];
        
        moduleEmbeddings = new Array(existingModules.length).fill([]);
        
        existingModules.forEach((m, idx) => {
          if (m.embedding && m.embedding.length > 0) {
            moduleEmbeddings[idx] = m.embedding;
          } else {
            textsToEmbed.push(`${m.title} ${m.summary}`);
            indicesToEmbed.push(idx);
          }
        });

        if (textsToEmbed.length > 0) {
          addLog(`Calculating missing embeddings for ${textsToEmbed.length} existing modules...`);
          const newEmbeddings = await getEmbeddingsBulk(textsToEmbed);
          newEmbeddings.forEach((emb, i) => {
            const originalIdx = indicesToEmbed[i];
            moduleEmbeddings[originalIdx] = emb;
          });
        }
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
          const textsToEmbed: string[] = [];
          const indicesToEmbed: number[] = [];
          
          logicEmbeddings = new Array(chunk.length).fill([]);
          
          chunk.forEach((logic, idx) => {
            if (logic.embedding && logic.embedding.length > 0) {
              logicEmbeddings[idx] = logic.embedding;
            } else {
              textsToEmbed.push(`${logic.title} ${logic.summary}`);
              indicesToEmbed.push(idx);
            }
          });

          if (textsToEmbed.length > 0) {
            addLog(`Calculating missing embeddings for ${textsToEmbed.length} logics in chunk...`);
            const newEmbeddings = await getEmbeddingsBulk(textsToEmbed);
            newEmbeddings.forEach((emb, i) => {
              const originalIdx = indicesToEmbed[i];
              logicEmbeddings[originalIdx] = emb;
            });
          }
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
              
              // We calculate the embedding for the new module right away so it can be used for subsequent mappings
              const [newModuleEmbedding] = await getEmbeddingsBulk([`${mapping.suggestedTitle} ${mapping.suggestedSummary || ''}`]);
              
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
                lastUpdated: serverTimestamp(),
                embeddingHash: await computeHash(`${mapping.suggestedTitle} ${mapping.suggestedSummary || ''}`),
                embeddingModel: 'gemini-embedding-2-preview',
                lastEmbeddedAt: serverTimestamp(),
                embedding: newModuleEmbedding
              };
              
              existingModules.push(newModuleData as Note);
              moduleEmbeddings.push(newModuleEmbedding);
              newModulesCreatedInChunk[mapping.suggestedTitle] = newModuleData;
              isNew = true;
              addLog(`Proposed new Module: ${newModuleData.title}`);
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
      <div className="p-4 sm:p-8 border-b border-border flex justify-between items-center bg-muted/5">
        <div>
          <h2 className="font-black text-foreground flex items-center gap-2 sm:gap-3 uppercase tracking-[0.3em] text-[10px] sm:text-xs italic">
            <Github size={18} className="text-primary glow-primary" /> Sync Engine
          </h2>
          <p className="text-[8px] sm:text-[10px] font-bold text-muted-foreground/40 uppercase tracking-widest mt-1">Repository Architect</p>
        </div>
        <button 
          onClick={onClose} 
          className="p-2 text-muted-foreground hover:bg-muted rounded-xl transition-all active:scale-95 border border-transparent hover:border-border/50" 
          title="Close Engine"
        >
          <X size={18} />
        </button>
      </div>
      
      <div className="p-4 sm:p-8 flex flex-col h-full overflow-hidden space-y-6 sm:space-y-8">
        {!projectId ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-6">
            <div className="w-16 h-16 bg-muted rounded-2xl flex items-center justify-center text-muted-foreground/30 shadow-inner">
              <Github size={32} />
            </div>
            <div className="space-y-2">
              <h3 className="text-sm font-bold text-foreground uppercase tracking-widest italic">No Project Selected</h3>
              <p className="text-[10px] text-muted-foreground/60 leading-relaxed max-w-[200px] mx-auto uppercase tracking-widest font-bold">
                Please select a project from the explorer to activate the sync engine.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4 sm:space-y-6">
            <div className="space-y-2 sm:space-y-3">
              <label className="text-[9px] sm:text-[10px] font-black text-muted-foreground uppercase tracking-[0.2em] ml-1">Source Repository</label>
              <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
                <input 
                  type="text" 
                  placeholder="https://github.com/owner/repo"
                  value={repoUrl}
                  onChange={e => setRepoUrl(e.target.value)}
                  className="flex-1 p-3 sm:p-4 bg-background/50 border border-border rounded-xl sm:rounded-2xl focus:ring-2 focus:ring-primary/20 outline-none text-[10px] sm:text-xs font-mono"
                />
                <button 
                  onClick={handleSaveUrl}
                  disabled={syncing}
                  className="px-6 py-2 bg-muted text-muted-foreground rounded-xl sm:rounded-2xl hover:bg-muted/80 disabled:opacity-50 text-[9px] sm:text-[10px] font-black uppercase tracking-widest transition-all border border-border/50"
                >
                  Save
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-4">
              {syncing || isMapping ? (
                <button 
                  onClick={handleCancelSync}
                  className="flex justify-center items-center gap-3 px-4 py-3 sm:py-4 bg-destructive text-destructive-foreground rounded-xl sm:rounded-2xl hover:opacity-90 text-[9px] sm:text-[10px] font-black uppercase tracking-[0.2em] shadow-xl shadow-destructive/20 transition-all active:scale-95"
                >
                  <X size={16} /> Abort
                </button>
              ) : (
                <button 
                  onClick={handleSync}
                  disabled={!repoUrl || resetting}
                  className="flex justify-center items-center gap-3 px-4 py-3 sm:py-4 bg-primary text-primary-foreground rounded-xl sm:rounded-2xl hover:opacity-90 disabled:opacity-50 text-[9px] sm:text-[10px] font-black uppercase tracking-[0.2em] shadow-xl shadow-primary/20 transition-all active:scale-95 glow-primary"
                >
                  <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} /> Sync
                </button>
              )}

              <button 
                onClick={handleModuleMapping}
                disabled={syncing || resetting || isMapping}
                className="flex justify-center items-center gap-3 px-4 py-3 sm:py-4 bg-secondary text-secondary-foreground rounded-xl sm:rounded-2xl hover:opacity-90 disabled:opacity-50 text-[9px] sm:text-[10px] font-black uppercase tracking-[0.2em] shadow-xl shadow-secondary/20 transition-all active:scale-95"
              >
                <RefreshCw size={16} className={isMapping ? 'animate-spin' : ''} /> {isMapping ? 'Mapping' : 'Auto-Map'}
              </button>
              
              <button 
                onClick={() => confirmReset ? executeReset() : setConfirmReset(true)}
                disabled={syncing || resetting || isMapping}
                className={`flex justify-center items-center gap-3 px-4 py-3 sm:py-4 rounded-xl sm:rounded-2xl text-[9px] sm:text-[10px] font-black uppercase tracking-[0.2em] transition-all active:scale-95 border ${
                  confirmReset 
                    ? 'bg-destructive text-destructive-foreground shadow-xl shadow-destructive/20 border-transparent' 
                    : 'bg-muted/30 text-muted-foreground hover:bg-destructive/10 hover:text-destructive border-border/50'
                } disabled:opacity-50`}
              >
                <Trash2 size={16} /> {confirmReset ? 'Confirm' : 'Reset'}
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex justify-between items-center mb-2 sm:mb-3 ml-1">
            <label className="text-[9px] sm:text-[10px] font-black text-muted-foreground uppercase tracking-[0.2em]">System Logs</label>
            <span className="text-[8px] font-mono text-muted-foreground/40 uppercase tracking-widest">Live Stream</span>
          </div>
          <div className="flex-1 bg-background/30 border border-border rounded-2xl sm:rounded-3xl p-4 sm:p-6 overflow-y-auto font-mono text-[9px] sm:text-[10px] text-foreground/60 custom-scrollbar shadow-inner relative">
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
