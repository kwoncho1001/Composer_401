import React, { useState, useEffect } from 'react';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, collection, arrayUnion, arrayRemove } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Note, NoteType, NoteStatus, NotePriority, OperationType } from '../types';
import { handleFirestoreError } from '../lib/utils';
import { Trash2, Save, Eye, Edit3, Sparkles, Loader2, AlertTriangle, CheckCircle2, FileWarning } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { reformatNote, analyzeLogicUnit, generateFixGuide } from '../services/gemini';
import { fetchFileContent } from '../services/github';

export const NoteEditor = ({ noteId, projectId, onSaved, onDeleted }: { noteId: string | null, projectId: string | null, onSaved: () => void, onDeleted?: () => void }) => {
  const [note, setNote] = useState<Partial<Note>>({
    title: '', summary: '', body: '', folder: '/', noteType: 'Domain', status: 'Planned', priority: 'C',
    parentNoteIds: [], childNoteIds: [], relatedNoteIds: []
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isPreview, setIsPreview] = useState(false);
  const [isFormatting, setIsFormatting] = useState(false);
  const [isResolvingConflict, setIsResolvingConflict] = useState(false);
  const [conflictResolutionGuide, setConflictResolutionGuide] = useState<string | null>(null);

  useEffect(() => {
    setConfirmDelete(false);
    setIsDirty(false);
    setConflictResolutionGuide(null);
    if (!noteId || noteId === 'new') {
      setNote({
        title: '', summary: '', body: '', folder: '/', noteType: 'Domain', status: 'Planned', priority: 'C',
        parentNoteIds: [], childNoteIds: [], relatedNoteIds: []
      });
      return;
    }

    const fetchNote = async () => {
      try {
        const docRef = doc(db, 'notes', noteId);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          const data = docSnap.id ? { id: docSnap.id, ...docSnap.data() } as Note : null;
          if (data && data.status === 'Done' && data.priority !== 'Done') {
            data.priority = 'Done';
            setIsDirty(true);
          }
          if (data) {
            // Ensure string fields are not null
            data.title = data.title || '';
            data.summary = data.summary || '';
            data.body = data.body || '';
            data.folder = data.folder || '/';
            // Ensure array fields are not undefined
            data.parentNoteIds = data.parentNoteIds || [];
            data.childNoteIds = data.childNoteIds || [];
            data.relatedNoteIds = data.relatedNoteIds || [];
            setNote(data);
            if (data.status === 'Done') setIsPreview(true);
          }
        }
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `notes/${noteId}`);
      }
    };
    fetchNote();
  }, [noteId]);

  // Debounced Auto-save
  useEffect(() => {
    if (!isDirty || noteId === 'new') return;

    const timer = setTimeout(() => {
      handleSave();
    }, 5000);

    return () => clearTimeout(timer);
  }, [note, isDirty]);

  const handleSave = async () => {
    if (!auth.currentUser || !projectId) return;
    setIsSaving(true);
    try {
      let finalNoteId = noteId;
      const oldParentIds = note.id ? (await getDoc(doc(db, 'notes', note.id))).data()?.parentNoteIds || [] : [];

      if (noteId === 'new') {
        const newRef = doc(collection(db, 'notes'));
        finalNoteId = newRef.id;
        await setDoc(newRef, {
          ...note,
          id: finalNoteId,
          projectId,
          uid: auth.currentUser.uid,
          lastUpdated: serverTimestamp()
        });
      } else if (noteId) {
        const docRef = doc(db, 'notes', noteId);
        await updateDoc(docRef, {
          ...note,
          lastUpdated: serverTimestamp()
        });
      }

      // Mirroring Logic: Update parents' childNoteIds
      const newParentIds = note.parentNoteIds || [];
      
      // 1. Add this note to new parents
      const addedParents = newParentIds.filter(id => !oldParentIds.includes(id));
      for (const pId of addedParents) {
        const pRef = doc(db, 'notes', pId);
        await updateDoc(pRef, {
          childNoteIds: arrayUnion(finalNoteId)
        }).catch(err => console.error(`Failed to update parent ${pId}`, err));
      }

      // 2. Remove this note from removed parents
      const removedParents = oldParentIds.filter(id => !newParentIds.includes(id));
      for (const pId of removedParents) {
        const pRef = doc(db, 'notes', pId);
        await updateDoc(pRef, {
          childNoteIds: arrayRemove(finalNoteId)
        }).catch(err => console.error(`Failed to update removed parent ${pId}`, err));
      }

      setIsDirty(false);
      onSaved();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'notes');
    } finally {
      setIsSaving(false);
    }
  };

  const updateNote = (updates: Partial<Note>) => {
    setNote(prev => {
      const next = { ...prev, ...updates };
      if (next.status === 'Done' && next.priority !== 'Done') {
        next.priority = 'Done';
      }
      return next;
    });
    setIsDirty(true);
  };

  const handleReformat = async () => {
    if (!note || !noteId || noteId === 'new') return;
    setIsFormatting(true);
    try {
      const reformatted = await reformatNote(note);
      
      const nextNote = { ...note, ...reformatted };
      if (nextNote.status === 'Done' && nextNote.priority !== 'Done') {
        nextNote.priority = 'Done';
      }
      
      setIsSaving(true);
      await updateDoc(doc(db, 'notes', noteId), {
        ...nextNote,
        lastUpdated: serverTimestamp()
      });
      
      setNote(nextNote);
      setIsDirty(false);
      onSaved();
    } catch (error) {
      console.error("Failed to reformat note", error);
      handleFirestoreError(error, OperationType.WRITE, `notes/${noteId}`);
    } finally {
      setIsFormatting(false);
      setIsSaving(false);
    }
  };

  const handleResolveConflictWithCode = async () => {
    if (!note || !noteId || !projectId || !note.originPath) return;
    setIsResolvingConflict(true);
    try {
      const projectDoc = await getDoc(doc(db, 'projects', projectId));
      if (!projectDoc.exists()) throw new Error("Project not found");
      const repoUrl = projectDoc.data().repoUrl;
      
      const fileContent = await fetchFileContent(repoUrl, note.originPath);
      const analyzed = await analyzeLogicUnit(note.title || '', fileContent);
      
      const nextNote = { 
        ...note, 
        summary: analyzed.summary,
        components: analyzed.components,
        flow: analyzed.flow,
        io: analyzed.io,
        status: 'Done' as NoteStatus,
        priority: 'Done' as NotePriority
      };
      
      setIsSaving(true);
      await updateDoc(doc(db, 'notes', noteId), {
        ...nextNote,
        lastUpdated: serverTimestamp()
      });
      
      setNote(nextNote);
      setIsDirty(false);
      onSaved();
    } catch (error) {
      console.error("Failed to resolve conflict with code", error);
      alert("Failed to resolve conflict: " + (error as Error).message);
    } finally {
      setIsResolvingConflict(false);
      setIsSaving(false);
    }
  };

  const handleResolveConflictWithDesign = async () => {
    if (!note || !noteId || !projectId || !note.originPath) return;
    setIsResolvingConflict(true);
    try {
      const projectDoc = await getDoc(doc(db, 'projects', projectId));
      if (!projectDoc.exists()) throw new Error("Project not found");
      const repoUrl = projectDoc.data().repoUrl;
      
      const fileContent = await fetchFileContent(repoUrl, note.originPath);
      const guide = await generateFixGuide(note as Note, fileContent);
      
      setConflictResolutionGuide(guide);
    } catch (error) {
      console.error("Failed to resolve conflict with design", error);
      alert("Failed to generate guide: " + (error as Error).message);
    } finally {
      setIsResolvingConflict(false);
    }
  };

  const handleDelete = async () => {
    if (!noteId || noteId === 'new') return;
    try {
      await deleteDoc(doc(db, 'notes', noteId));
      if (onDeleted) onDeleted();
      else onSaved();
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `notes/${noteId}`);
    }
  };

  const formatTimestamp = (ts: any) => {
    if (!ts) return 'N/A';
    const date = ts.toDate ? ts.toDate() : new Date(ts);
    return date.toLocaleString('ko-KR', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  if (!noteId) return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-12">
      <div className="w-16 h-16 bg-muted rounded-2xl flex items-center justify-center mb-6 text-muted-foreground/30">
        <Save size={32} />
      </div>
      <h3 className="text-xl font-bold mb-2">No Note Selected</h3>
      <p className="text-muted-foreground max-w-xs">Select a note from the explorer or create a new one to start editing.</p>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col bg-card text-foreground rounded-2xl sm:rounded-3xl shadow-2xl border border-border overflow-hidden glass h-full">
      {/* Header */}
      <div className="p-4 sm:p-8 border-b border-border flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6 bg-muted/5 backdrop-blur-md sticky top-0 z-10">
        <div className="flex-1 w-full">
          <input 
            type="text" 
            value={note.title || ''} 
            onChange={e => updateNote({title: e.target.value})}
            placeholder="Note Title..."
            maxLength={200}
            className="text-xl sm:text-3xl font-black bg-transparent border-none outline-none w-full text-foreground placeholder:text-muted-foreground/20 tracking-tighter uppercase italic"
          />
          <div className="flex items-center gap-2 sm:gap-4 mt-2 sm:mt-3 flex-wrap">
            <div className="flex items-center gap-2 px-2 py-1 bg-muted rounded text-[10px] sm:text-xs font-mono font-bold text-muted-foreground border border-border/50">
              <span className="opacity-60 uppercase tracking-widest text-[8px] sm:text-[9px]">UID:</span>
              <span>{note.id || 'NEW_ENTRY'}</span>
            </div>
            <div className="flex items-center gap-2 px-2 py-1 bg-primary/10 rounded text-[10px] sm:text-xs font-mono font-bold text-primary border border-primary/20">
              <span className="opacity-60 uppercase tracking-widest text-[8px] sm:text-[9px]">Type:</span>
              <span>{note.noteType || 'Domain'}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center w-full lg:w-auto">
          {isSaving && (
            <span className="text-[10px] font-bold text-primary animate-pulse uppercase tracking-widest sm:mr-2">
              Syncing...
            </span>
          )}
          <div className="grid grid-cols-2 sm:flex gap-2 w-full sm:w-auto">
            <button
              onClick={handleReformat}
              disabled={isFormatting || isSaving || noteId === 'new'}
              className="flex items-center justify-center gap-2 px-3 py-2 bg-primary/10 hover:bg-primary/20 text-primary text-[9px] sm:text-[10px] font-black uppercase tracking-widest rounded-xl transition-all active:scale-95 border border-primary/20 disabled:opacity-50 flex-1 sm:flex-none"
              title="AI로 가독성 있게 재구성"
            >
              {isFormatting ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Sparkles size={12} />
              )}
              <span>AI Format</span>
            </button>
            <button 
              onClick={() => setIsPreview(!isPreview)}
              className={`flex items-center justify-center gap-2 px-3 py-2 text-[9px] sm:text-[10px] font-black uppercase tracking-widest rounded-xl transition-all active:scale-95 border flex-1 sm:flex-none ${
                isPreview 
                  ? 'bg-primary/10 text-primary border-primary/20' 
                  : 'bg-muted text-muted-foreground hover:bg-accent border-border'
              }`}
              title={isPreview ? "Switch to Edit Mode" : "Switch to Preview Mode"}
            >
              {isPreview ? <Edit3 size={12} /> : <Eye size={12} />}
              {isPreview ? 'Edit' : 'Preview'}
            </button>
            <button 
              onClick={handleSave} 
              disabled={isSaving || !isDirty}
              className="flex items-center justify-center gap-2 px-3 py-2 bg-primary text-primary-foreground text-[9px] sm:text-[10px] font-black uppercase tracking-widest rounded-xl hover:opacity-90 transition-all shadow-lg shadow-primary/20 active:scale-95 glow-primary disabled:opacity-50 flex-1 sm:flex-none"
            >
              <Save size={12} className={isSaving ? 'animate-spin' : ''} /> {isSaving ? 'Sync' : 'Save'}
            </button>
            {noteId !== 'new' && (
              <button 
                onClick={() => {
                  if (confirmDelete) handleDelete();
                  else setConfirmDelete(true);
                }} 
                className={`flex items-center justify-center gap-2 px-3 py-2 text-[9px] sm:text-[10px] font-black uppercase tracking-widest rounded-xl transition-all active:scale-95 flex-1 sm:flex-none ${
                  confirmDelete 
                    ? 'bg-destructive text-destructive-foreground shadow-lg shadow-destructive/20' 
                    : 'bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive border border-border'
                }`}
              >
                <Trash2 size={12} /> {confirmDelete ? 'Confirm' : 'Delete'}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-8 space-y-8 sm:space-y-12 custom-scrollbar">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Left Column: Core Configuration & Version Control */}
          <div className="space-y-8">
            {/* Core Configuration */}
            <section className="bg-muted/10 border border-border/50 rounded-3xl p-8 space-y-6 relative overflow-hidden group">
              <div className="absolute top-0 left-0 w-1 h-full bg-green-500/50 group-hover:bg-green-500 transition-colors"></div>
              <h3 className="text-[10px] font-black text-muted-foreground uppercase tracking-[0.3em] flex items-center gap-3">
                Core Configuration
              </h3>
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <label className="block text-xs font-black text-muted-foreground/70 uppercase mb-2 tracking-widest">UID</label>
                  <div className="w-full bg-background/30 border border-border rounded-xl p-3 text-xs font-mono font-bold text-muted-foreground truncate">
                    {note.id || 'NEW_ENTRY'}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-black text-muted-foreground/70 uppercase mb-2 tracking-widest">Type</label>
                  <select 
                    value={note.noteType} 
                    onChange={e => updateNote({noteType: e.target.value as NoteType})}
                    className="w-full bg-background/50 border border-border rounded-xl p-3 text-xs font-bold focus:ring-2 focus:ring-primary/20 outline-none transition-all appearance-none cursor-pointer"
                  >
                    <option value="Domain">Domain</option>
                    <option value="Module">Module</option>
                    <option value="Logic">Logic</option>
                    <option value="Snapshot">Snapshot</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-black text-muted-foreground/70 uppercase mb-2 tracking-widest">Status</label>
                  <select 
                    value={note.status} 
                    onChange={e => {
                      const newStatus = e.target.value as NoteStatus;
                      const updates: any = { status: newStatus };
                      if (newStatus === 'Done') updates.priority = 'Done';
                      updateNote(updates);
                    }}
                    className="w-full bg-background/50 border border-border rounded-xl p-3 text-xs font-bold focus:ring-2 focus:ring-primary/20 outline-none transition-all appearance-none cursor-pointer"
                  >
                    <option value="Planned">Planned</option>
                    <option value="Done">Done</option>
                    <option value="Conflict">Conflict</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-black text-muted-foreground/70 uppercase mb-2 tracking-widest">Priority</label>
                  <select 
                    value={note.priority} 
                    onChange={e => updateNote({priority: e.target.value as NotePriority})}
                    disabled={note.status === 'Done'}
                    className={`w-full bg-background/50 border border-border rounded-xl p-3 text-xs font-bold focus:ring-2 focus:ring-primary/20 outline-none transition-all appearance-none cursor-pointer ${note.status === 'Done' ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <option value="A">A - Critical</option>
                    <option value="B">B - Normal</option>
                    <option value="C">C - Low</option>
                    <option value="Done">Done</option>
                  </select>
                </div>
              </div>
            </section>

            {/* Version Control */}
            <section className="bg-muted/10 border border-border/50 rounded-3xl p-8 space-y-6 relative overflow-hidden group">
              <div className="absolute top-0 left-0 w-1 h-full bg-primary/50 group-hover:bg-primary transition-colors"></div>
              <h3 className="text-[10px] font-black text-muted-foreground uppercase tracking-[0.3em] flex items-center gap-3">
                Version Control
              </h3>
              <div className="space-y-4 text-xs">
                <div className="flex flex-col gap-1.5 py-3 border-b border-border/30">
                  <span className="text-xs font-black text-muted-foreground/70 uppercase tracking-widest">Origin Path</span>
                  <span className="font-mono text-xs text-primary truncate">{note.originPath || 'LOCAL_ONLY'}</span>
                </div>
                <div className="flex flex-col gap-1.5 py-3 border-b border-border/30">
                  <span className="text-xs font-black text-muted-foreground/70 uppercase tracking-widest">Commit SHA</span>
                  <span className="font-mono text-xs text-muted-foreground truncate">{note.sha || 'UNCOMMITTED'}</span>
                </div>
                <div className="flex justify-between items-center py-3">
                  <span className="text-xs font-black text-muted-foreground/70 uppercase tracking-widest">Last Sync</span>
                  <span className="text-xs font-bold font-mono text-foreground">{formatTimestamp(note.lastUpdated)}</span>
                </div>
              </div>
            </section>
          </div>

          {/* Right Column: System Architecture */}
          <div className="h-full">
            <section className="bg-muted/10 border border-border/50 rounded-3xl p-8 space-y-6 relative overflow-hidden group h-full">
              <div className="absolute top-0 left-0 w-1 h-full bg-purple-500/50 group-hover:bg-purple-500 transition-colors"></div>
              <h3 className="text-[10px] font-black text-muted-foreground uppercase tracking-[0.3em] flex items-center gap-3">
                System Architecture
              </h3>
              <div className="space-y-6">
                <div>
                  <label className="block text-xs font-black text-muted-foreground/70 uppercase mb-2 tracking-widest">Parent Nodes</label>
                  <input 
                    type="text" 
                    value={note.parentNoteIds?.join(', ') || ''} 
                    onChange={e => updateNote({parentNoteIds: e.target.value.split(',').map(s => s.trim()).filter(Boolean)})}
                    className="w-full bg-background/50 border border-border rounded-xl p-3 text-xs font-mono focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                    placeholder="NODE_ID_1, NODE_ID_2..."
                  />
                </div>
                <div>
                  <label className="block text-xs font-black text-muted-foreground/70 uppercase mb-2 tracking-widest">Child Nodes</label>
                  <div className="w-full bg-background/30 border border-border border-dashed rounded-xl p-3 text-[10px] font-mono text-muted-foreground min-h-[44px] flex flex-wrap gap-2">
                    {note.childNoteIds?.length ? note.childNoteIds.map(id => (
                      <span key={id} className="bg-muted px-2 py-0.5 rounded border border-border/50 text-foreground font-bold">{id}</span>
                    )) : 'NO_CHILD_NODES_DETECTED'}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-black text-muted-foreground/70 uppercase mb-2 tracking-widest">Related Nodes</label>
                  <input 
                    type="text" 
                    value={note.relatedNoteIds?.join(', ') || ''} 
                    onChange={e => updateNote({relatedNoteIds: e.target.value.split(',').map(s => s.trim()).filter(Boolean)})}
                    className="w-full bg-background/50 border border-border rounded-xl p-3 text-xs font-mono focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                    placeholder="NODE_ID_1, NODE_ID_2..."
                  />
                </div>
              </div>
            </section>
          </div>
        </div>

        {/* Content Area */}
        <div className="space-y-8">
          {note.status === 'Conflict' && (
            <div className="bg-destructive/10 border border-destructive/50 rounded-3xl p-8 space-y-6 relative overflow-hidden group">
              <div className="absolute top-0 left-0 w-1 h-full bg-destructive/50 group-hover:bg-destructive transition-colors"></div>
              <h3 className="text-[12px] font-black text-destructive uppercase tracking-[0.3em] flex items-center gap-3">
                <AlertTriangle size={16} />
                Conflict Detected
              </h3>
              <p className="text-sm text-foreground/80 leading-relaxed">
                Github 파일이 업데이트되어 기존 설계 노트와 매핑되었으나 디테일이 다릅니다. (혹은 설계도와 Github 구현이 다릅니다.)<br/>
                어느 쪽이 맞는지 선택하여 Conflict를 해결해 주세요.
              </p>

              {note.conflictDetails && (
                <div className="mt-6 space-y-4">
                  <div className="bg-background/50 border border-border rounded-2xl p-4">
                    <h4 className="text-sm font-bold text-foreground mb-2 flex items-center gap-2">
                      <Sparkles size={14} className="text-primary" />
                      분석 요약
                    </h4>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {note.conflictDetails.summary}
                    </p>
                  </div>

                  <div className="space-y-4">
                    {note.conflictDetails.differences.map((diff, idx) => (
                      <div key={idx} className="bg-background/50 border border-border rounded-2xl p-4 space-y-3">
                        <h5 className="text-xs font-black text-primary uppercase tracking-widest">
                          [차이점 {idx + 1}: {diff.aspect}]
                        </h5>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="space-y-1">
                            <span className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">📝 기획 (Design)</span>
                            <p className="text-sm text-foreground/90">{diff.design}</p>
                          </div>
                          <div className="space-y-1">
                            <span className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">💻 코드 (Code)</span>
                            <p className="text-sm text-foreground/90">{diff.code}</p>
                          </div>
                        </div>
                        <div className="pt-2 border-t border-border/50 mt-2">
                          <span className="text-[10px] font-black text-destructive uppercase tracking-widest flex items-center gap-1">
                            <AlertTriangle size={10} /> 영향 (Impact)
                          </span>
                          <p className="text-sm text-muted-foreground mt-1">{diff.impact}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-4">
                <button 
                  onClick={handleResolveConflictWithCode}
                  disabled={isResolvingConflict}
                  className="flex-1 bg-background border border-border hover:border-primary hover:bg-primary/5 p-4 rounded-2xl transition-all text-left group/btn disabled:opacity-50"
                >
                  <div className="font-bold text-primary mb-1 flex items-center gap-2">
                    {isResolvingConflict ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                    코드가 맞습니다 (설계 업데이트)
                  </div>
                  <div className="text-xs text-muted-foreground">
                    실제 작성된 코드가 최신이고 맞다고 판단될 때 선택합니다. AI가 코드의 내용을 바탕으로 기존 설계 노트를 자동으로 덮어쓰고 업데이트합니다.
                  </div>
                </button>
                <button 
                  onClick={handleResolveConflictWithDesign}
                  disabled={isResolvingConflict}
                  className="flex-1 bg-background border border-border hover:border-amber-500 hover:bg-amber-500/5 p-4 rounded-2xl transition-all text-left group/btn disabled:opacity-50"
                >
                  <div className="font-bold text-amber-500 mb-1 flex items-center gap-2">
                    {isResolvingConflict ? <Loader2 size={16} className="animate-spin" /> : <FileWarning size={16} />}
                    설계가 맞습니다 (수정 가이드 생성)
                  </div>
                  <div className="text-xs text-muted-foreground">
                    기존 설계가 맞고 코드가 잘못 짜였다고 판단될 때 선택합니다. AI가 코드를 설계에 맞게 어떻게 수정해야 하는지 구현 보정 가이드(가이드라인)를 생성합니다.
                  </div>
                </button>
              </div>
              
              {conflictResolutionGuide && (
                <div className="mt-6 p-6 bg-background border border-amber-500/30 rounded-2xl">
                  <h4 className="text-xs font-bold text-amber-500 uppercase tracking-widest mb-4">구현 보정 가이드</h4>
                  <div className="markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{conflictResolutionGuide}</ReactMarkdown>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="bg-muted/10 border border-border/50 rounded-3xl p-8 space-y-6 relative group">
            <div className="absolute top-0 left-0 w-1 h-full bg-amber-500/50 group-hover:bg-amber-500 transition-colors"></div>
            <label className="block text-[10px] font-black text-muted-foreground uppercase tracking-[0.3em]">
              1. {note.noteType === 'Snapshot' ? '기술적 역할 (Technical Role)' : '비즈니스 요약 (Summary)'}
            </label>
            {isPreview ? (
              <div className="markdown-body min-h-[128px] bg-background/30 border border-border/30 rounded-2xl p-5 overflow-y-auto">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{note.summary || ''}</ReactMarkdown>
              </div>
            ) : (
              <textarea 
                value={note.summary || ''} 
                onChange={e => updateNote({summary: e.target.value})}
                maxLength={50000}
                className="w-full h-32 bg-background/50 border border-border rounded-2xl p-5 text-sm text-foreground/80 focus:ring-2 focus:ring-primary/20 outline-none resize-none leading-relaxed transition-all"
                placeholder={note.noteType === 'Snapshot' ? "AI가 분석한 이 코드 조각의 기술적인 핵심 기능을 정의합니다..." : "이 로직이 최종적으로 달성하려는 목적을 한 문장으로 정의합니다..."}
              />
            )}
          </div>

          <div className="bg-muted/10 border border-border/50 rounded-3xl p-8 space-y-6 relative group">
            <div className="absolute top-0 left-0 w-1 h-full bg-blue-500/50 group-hover:bg-blue-500 transition-colors"></div>
            <label className="block text-[10px] font-black text-muted-foreground uppercase tracking-[0.3em]">
              2. {note.noteType === 'Snapshot' ? '기술적 구성 요소 (Technical Components)' : '비즈니스 구성 요소 (Business Components)'}
            </label>
            {isPreview ? (
              <div className="markdown-body min-h-[192px] bg-background/30 border border-border/30 rounded-2xl p-5 overflow-y-auto custom-scrollbar">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{note.components || ''}</ReactMarkdown>
              </div>
            ) : (
              <textarea 
                value={note.components || ''} 
                onChange={e => updateNote({components: e.target.value})}
                maxLength={50000}
                className="w-full h-48 bg-background/50 border border-border rounded-2xl p-5 text-sm text-foreground/80 focus:ring-2 focus:ring-primary/20 outline-none resize-none leading-relaxed transition-all custom-scrollbar"
                placeholder={note.noteType === 'Snapshot' ? "실제 코드에 존재하는 물리적 부품들을 나열합니다 (라이브러리, 변수, 함수 등)..." : "이 로직에서 다루는 주요 개념적 단위들을 나열합니다..."}
              />
            )}
          </div>

          <div className="bg-muted/10 border border-border/50 rounded-3xl p-8 space-y-6 relative group">
            <div className="absolute top-0 left-0 w-1 h-full bg-green-500/50 group-hover:bg-green-500 transition-colors"></div>
            <label className="block text-[10px] font-black text-muted-foreground uppercase tracking-[0.3em]">
              3. {note.noteType === 'Snapshot' ? '데이터/실행 흐름 (Execution Flow)' : '논리적 흐름 (Step-by-Step)'}
            </label>
            {isPreview ? (
              <div className="markdown-body min-h-[256px] bg-background/30 border border-border/30 rounded-2xl p-5 overflow-y-auto custom-scrollbar">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{note.flow || ''}</ReactMarkdown>
              </div>
            ) : (
              <textarea 
                value={note.flow || ''} 
                onChange={e => updateNote({flow: e.target.value})}
                maxLength={50000}
                className="w-full h-64 bg-background/50 border border-border rounded-2xl p-5 text-sm text-foreground/80 focus:ring-2 focus:ring-primary/20 outline-none resize-none leading-relaxed transition-all custom-scrollbar"
                placeholder={note.noteType === 'Snapshot' ? "코드의 실제 실행 순서와 데이터가 변하는 과정을 기록합니다..." : "코드가 아닌 '사람의 행동/의사결정' 순서로 설명합니다..."}
              />
            )}
          </div>

          <div className="bg-muted/10 border border-border/50 rounded-3xl p-8 space-y-6 relative group">
            <div className="absolute top-0 left-0 w-1 h-full bg-purple-500/50 group-hover:bg-purple-500 transition-colors"></div>
            <label className="block text-[10px] font-black text-muted-foreground uppercase tracking-[0.3em]">
              4. {note.noteType === 'Snapshot' ? '기술적 입출력 (Technical I/O)' : '비즈니스 입출력 (Business I/O)'}
            </label>
            {isPreview ? (
              <div className="markdown-body min-h-[128px] bg-background/30 border border-border/30 rounded-2xl p-5 overflow-y-auto custom-scrollbar">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{note.io || ''}</ReactMarkdown>
              </div>
            ) : (
              <textarea 
                value={note.io || ''} 
                onChange={e => updateNote({io: e.target.value})}
                maxLength={50000}
                className="w-full h-32 bg-background/50 border border-border rounded-2xl p-5 text-sm text-foreground/80 focus:ring-2 focus:ring-primary/20 outline-none resize-none leading-relaxed transition-all custom-scrollbar"
                placeholder={note.noteType === 'Snapshot' ? "입력(Parameters)과 출력(Returns)을 명시합니다..." : "입력(Input)과 출력(Output)을 명시합니다..."}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
