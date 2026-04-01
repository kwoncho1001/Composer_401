import React, { useEffect, useState, useRef } from 'react';
import { collection, onSnapshot, query, where, deleteDoc, doc, addDoc, serverTimestamp, getDocs, writeBatch } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Note, Project, OperationType } from '../types';
import { handleFirestoreError } from '../lib/utils';
import { Folder, FileText, Plus, CheckSquare, Trash2, PanelLeftClose, ChevronDown, Check, FolderGit2, Circle, CheckCircle2, RefreshCw } from 'lucide-react';

export const Sidebar = ({ 
  onSelectNote, 
  selectedNoteId, 
  onClose,
  selectedProjectId,
  onSelectProject
}: { 
  onSelectNote: (id: string) => void, 
  selectedNoteId: string | null, 
  onClose: () => void,
  selectedProjectId: string | null,
  onSelectProject: (id: string | null) => void
}) => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  
  const [isProjectMenuOpen, setIsProjectMenuOpen] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [isDeletingProject, setIsDeletingProject] = useState(false);
  const [projectToDeleteId, setProjectToDeleteId] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [collapsedIds, setCollapsedIds] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<'business' | 'snapshot'>('business');

  const subtreeStatusMap = React.useMemo(() => {
    const statusMap: Record<string, 'Done' | 'Conflict' | 'Planned'> = {};
    
    const calculateStatus = (id: string): 'Done' | 'Conflict' | 'Planned' => {
      if (statusMap[id]) return statusMap[id];
      
      const note = notes.find(n => n.id === id);
      if (!note) return 'Planned';

      const children = notes.filter(n => n.parentNoteIds.includes(id));
      
      let hasConflict = note.status === 'Conflict';
      let allDone = note.status === 'Done';

      for (const child of children) {
        const childStatus = calculateStatus(child.id);
        if (childStatus === 'Conflict') hasConflict = true;
        if (childStatus !== 'Done') allDone = false;
      }

      const result = hasConflict ? 'Conflict' : (allDone ? 'Done' : 'Planned');
      statusMap[id] = result;
      return result;
    };

    notes.forEach(n => {
      if (n.parentNoteIds.length === 0) {
        calculateStatus(n.id);
      }
    });

    // Ensure all notes are calculated even if orphaned
    notes.forEach(n => calculateStatus(n.id));

    return statusMap;
  }, [notes]);

  useEffect(() => {
    if (!auth.currentUser) return;
    const q = query(collection(db, 'projects'), where('uid', '==', auth.currentUser.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetchedProjects = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Project));
      setProjects(fetchedProjects);
      if (fetchedProjects.length > 0 && !selectedProjectId) {
        onSelectProject(fetchedProjects[0].id);
      } else if (fetchedProjects.length === 0) {
        onSelectProject(null);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'projects');
    });
    return () => unsubscribe();
  }, [selectedProjectId, onSelectProject]);

  useEffect(() => {
    if (!auth.currentUser || !selectedProjectId) {
      setNotes([]);
      return;
    }
    const q = query(
      collection(db, 'notes'), 
      where('uid', '==', auth.currentUser.uid),
      where('projectId', '==', selectedProjectId)
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetchedNotes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Note));
      setNotes(fetchedNotes);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'notes');
    });

    return () => unsubscribe();
  }, [selectedProjectId]);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim() || !auth.currentUser) return;
    try {
      const docRef = await addDoc(collection(db, 'projects'), {
        name: newProjectName.trim(),
        repoUrl: '',
        uid: auth.currentUser.uid,
        createdAt: serverTimestamp()
      });
      onSelectProject(docRef.id);
      setIsCreatingProject(false);
      setNewProjectName('');
      setIsProjectMenuOpen(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'projects');
    }
  };

  const executeDeleteProject = async (projectId: string) => {
    if (!auth.currentUser) return;
    setIsDeletingProject(true);

    try {
      // 1. Delete all notes for this project
      const notesQuery = query(
        collection(db, 'notes'), 
        where('uid', '==', auth.currentUser.uid),
        where('projectId', '==', projectId)
      );
      const notesSnap = await getDocs(notesQuery);
      
      let batch = writeBatch(db);
      let count = 0;
      for (const d of notesSnap.docs) {
        batch.delete(doc(db, 'notes', d.id));
        count++;
        if (count >= 450) {
          await batch.commit();
          batch = writeBatch(db);
          count = 0;
        }
      }
      if (count > 0) await batch.commit();

      // 2. Delete sync ledger
      const ledgerQuery = query(
        collection(db, 'syncLedgers'), 
        where('uid', '==', auth.currentUser.uid),
        where('projectId', '==', projectId)
      );
      const ledgerSnap = await getDocs(ledgerQuery);
      for (const d of ledgerSnap.docs) {
        await deleteDoc(doc(db, 'syncLedgers', d.id));
      }

      // 3. Delete project
      await deleteDoc(doc(db, 'projects', projectId));

      if (selectedProjectId === projectId) {
        onSelectProject(null);
        onSelectNote('new');
      }
      setIsProjectMenuOpen(false);
      setProjectToDeleteId(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `projects/${projectId}`);
    } finally {
      setIsDeletingProject(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;

    try {
      await Promise.all(selectedIds.map(id => deleteDoc(doc(db, 'notes', id))));
      if (selectedNoteId && selectedIds.includes(selectedNoteId)) {
        onSelectNote('new');
      }
      setSelectedIds([]);
      setSelectionMode(false);
      setConfirmDelete(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, 'notes');
    }
  };

  const handleSelectAll = () => {
    if (notes.length === 0) return;
    if (selectedIds.length === notes.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(notes.map(n => n.id));
    }
  };

  const getAllDescendantIds = (parentId: string): string[] => {
    let descendants: string[] = [];
    const children = notes.filter(n => n.parentNoteIds.includes(parentId));
    for (const child of children) {
      descendants.push(child.id);
      descendants = descendants.concat(getAllDescendantIds(child.id));
    }
    return descendants;
  };

  const renderItem = (item: Note) => {
    const isSelected = selectedIds.includes(item.id);
    const isActive = selectedNoteId === item.id && !selectionMode;
    const isFolder = item.noteType !== 'Snapshot';
    const isCollapsed = collapsedIds.includes(item.id);
    const status = subtreeStatusMap[item.id] || 'Planned';
    
    const getStatusColor = () => {
      if (status === 'Conflict') return 'text-destructive';
      if (status === 'Done') return 'text-green-500';
      return isActive ? 'text-primary' : 'text-muted-foreground/70';
    };

    return (
      <div 
        className={`group flex items-center gap-2 p-2 rounded-xl cursor-pointer transition-all duration-200 border border-transparent ${
          isActive 
            ? 'bg-primary/10 shadow-lg shadow-primary/5 border-primary/20' 
            : 'hover:bg-muted/50 hover:border-border/50'
        } ${getStatusColor()}`}
        onClick={(e) => {
          if (selectionMode) {
            const isCurrentlySelected = selectedIds.includes(item.id);
            const descendantIds = getAllDescendantIds(item.id);
            const idsToToggle = [item.id, ...descendantIds];

            if (isCurrentlySelected) {
              // Deselect item and all its descendants
              setSelectedIds(prev => prev.filter(id => !idsToToggle.includes(id)));
            } else {
              // Select item and all its descendants
              setSelectedIds(prev => Array.from(new Set([...prev, ...idsToToggle])));
            }
          } else {
            onSelectNote(item.id);
          }
        }}
      >
        {selectionMode && (
          <input 
            type="checkbox" 
            checked={isSelected} 
            readOnly
            className="w-3.5 h-3.5 rounded border-border bg-background text-primary focus:ring-primary transition-all"
          />
        )}
        
        <div className="flex items-center gap-1">
          {isFolder && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setCollapsedIds(prev => 
                  isCollapsed ? prev.filter(id => id !== item.id) : [...prev, item.id]
                );
              }}
              className="p-0.5 hover:bg-accent rounded-md transition-colors text-inherit opacity-50 hover:opacity-100"
            >
              <ChevronDown size={10} className={`transition-transform duration-200 ${isCollapsed ? '-rotate-90' : ''}`} />
            </button>
          )}

          {status === 'Done' ? (
            <CheckCircle2 size={12} className="shrink-0" />
          ) : (
            <Circle size={12} className="shrink-0 opacity-40" />
          )}
        </div>

        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-[11px] font-bold truncate tracking-tight uppercase leading-none">{item.title || 'UNTITLED_NODE'}</span>
        </div>
        {isActive && <div className="w-1 h-1 rounded-full bg-primary glow-primary animate-pulse" />}
      </div>
    );
  };

  const renderSnapshotTree = () => {
    // Find all Snapshot notes that have an originPath
    const snapshotNotes = notes.filter(n => n.noteType === 'Snapshot' && n.originPath);
    
    // Group by originPath
    const pathGroups: Record<string, Note[]> = {};
    snapshotNotes.forEach(snap => {
      const path = snap.originPath!;
      if (!pathGroups[path]) pathGroups[path] = [];
      pathGroups[path].push(snap);
    });

    const sortedPaths = Object.keys(pathGroups).sort();

    return sortedPaths.map(path => {
      const isCollapsed = collapsedIds.includes(`folder:${path}`);
      const snapsInPath = pathGroups[path];
      
      // Find unique parent Logic notes for these snapshots
      const parentIds = Array.from(new Set(snapsInPath.flatMap(s => s.parentNoteIds)));
      const logicNotes = notes.filter(n => parentIds.includes(n.id) && n.noteType === 'Logic');
      const orphanSnaps = snapsInPath.filter(s => !s.parentNoteIds.some(pid => logicNotes.some(l => l.id === pid)));

      return (
        <div key={`folder:${path}`} className="mt-1">
          <div 
            className="group flex items-center gap-2 p-2 rounded-xl cursor-pointer hover:bg-muted/50 transition-all text-muted-foreground"
            onClick={() => {
              setCollapsedIds(prev => 
                isCollapsed ? prev.filter(id => id !== `folder:${path}`) : [...prev, `folder:${path}`]
              );
            }}
          >
            <ChevronDown size={12} className={`transition-transform duration-200 ${isCollapsed ? '-rotate-90' : ''}`} />
            <FolderGit2 size={14} className="text-primary/70" />
            <span className="text-[11px] font-bold truncate tracking-tight">{path}</span>
          </div>
          
          {!isCollapsed && (
            <div className="mt-1">
              {logicNotes.map(logicNote => {
                const isLogicCollapsed = collapsedIds.includes(logicNote.id);
                // Only show snapshots that belong to this path and this logic note
                const childSnaps = snapsInPath.filter(s => s.parentNoteIds.includes(logicNote.id));
                
                return (
                  <div key={logicNote.id} className="ml-4 border-l border-border/30 pl-2 mt-1">
                    {renderItem(logicNote)}
                    {!isLogicCollapsed && (
                      <div className="mt-1">
                        {childSnaps.map(snap => (
                          <div key={snap.id} className="ml-4 border-l border-border/30 pl-2 mt-1">
                            {renderItem(snap)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {orphanSnaps.map(snap => (
                <div key={snap.id} className="ml-4 border-l border-border/30 pl-2 mt-1">
                  {renderItem(snap)}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    });
  };

  const renderTree = (parentId: string | null) => {
    const children = notes.filter(n => {
      if (parentId === null) return n.parentNoteIds.length === 0;
      return n.parentNoteIds.includes(parentId);
    });

    // Sort by noteType to keep Domain -> Module -> Logic -> Snapshot order
    const typeOrder: Record<string, number> = { 'Domain': 0, 'Module': 1, 'Logic': 2, 'Snapshot': 3 };
    children.sort((a, b) => typeOrder[a.noteType] - typeOrder[b.noteType] || a.title.localeCompare(b.title));

    return children.map(item => {
      const isCollapsed = collapsedIds.includes(item.id);
      return (
        <div key={item.id} className={parentId === null ? "mt-1" : "ml-4 border-l border-border/30 pl-2 mt-1"}>
          {renderItem(item)}
          {!isCollapsed && (
            <div className="mt-1">
              {renderTree(item.id)}
            </div>
          )}
        </div>
      );
    });
  };

  const selectedProject = projects.find(p => p.id === selectedProjectId);

  return (
    <div className="w-full bg-card h-full flex flex-col relative border-r border-border">
      {/* Project Selector Header */}
      <div className="p-5 border-b border-border flex justify-between items-center bg-card/80 backdrop-blur-sm z-10">
        <div className="relative flex-1">
          <button 
            onClick={() => setIsProjectMenuOpen(!isProjectMenuOpen)}
            className="flex items-center gap-2.5 font-bold text-foreground hover:bg-accent p-2 rounded-xl w-full text-left transition-all"
          >
            <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center text-primary glow-primary">
              <FolderGit2 size={18} />
            </div>
            <span className="truncate flex-1 text-sm tracking-tight">{selectedProject ? selectedProject.name : 'Select Project'}</span>
            <ChevronDown size={16} className="text-muted-foreground" />
          </button>

          {isProjectMenuOpen && (
            <div className="absolute top-full left-0 w-full mt-2 bg-popover border border-border shadow-2xl rounded-2xl overflow-hidden z-50 glass">
              {projectToDeleteId ? (
                <div className="p-4 space-y-4 animate-in fade-in zoom-in-95 duration-200">
                  <p className="text-[10px] font-black text-foreground text-center leading-relaxed uppercase tracking-wider">
                    Delete project and all notes?<br/>
                    <span className="text-destructive">This cannot be undone.</span>
                  </p>
                  <div className="flex gap-2">
                    <button 
                      onClick={() => executeDeleteProject(projectToDeleteId)}
                      disabled={isDeletingProject}
                      className="flex-1 bg-destructive text-destructive-foreground text-[10px] font-black uppercase py-2.5 rounded-xl shadow-lg shadow-destructive/20 active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {isDeletingProject ? (
                        <>
                          <RefreshCw size={12} className="animate-spin" />
                          Deleting...
                        </>
                      ) : 'Delete'}
                    </button>
                    <button 
                      onClick={() => setProjectToDeleteId(null)}
                      disabled={isDeletingProject}
                      className="flex-1 bg-muted text-muted-foreground text-[10px] font-black uppercase py-2.5 rounded-xl active:scale-95 transition-all disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="max-h-60 overflow-y-auto p-1">
                    {projects.map(p => (
                      <div key={p.id} className="group/project relative">
                        <button
                          onClick={() => {
                            onSelectProject(p.id);
                            setIsProjectMenuOpen(false);
                            setIsCreatingProject(false);
                          }}
                          className={`w-full text-left px-4 py-2.5 text-sm rounded-xl flex items-center justify-between transition-colors ${
                            p.id === selectedProjectId ? 'bg-primary/10 text-primary font-semibold' : 'hover:bg-accent text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          <span className="truncate pr-6">{p.name}</span>
                          {p.id === selectedProjectId && <Check size={14} />}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setProjectToDeleteId(p.id);
                          }}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground/20 group-hover/project:text-destructive hover:bg-destructive/10 rounded-lg transition-all"
                          title="Delete Project"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-border p-3 bg-muted/30">
                    {isCreatingProject ? (
                      <form onSubmit={handleCreateProject} className="flex flex-col gap-2">
                        <input
                          type="text"
                          placeholder="Project Name"
                          value={newProjectName}
                          onChange={e => setNewProjectName(e.target.value)}
                          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:ring-2 focus:ring-primary/20 outline-none"
                          autoFocus
                        />
                        <div className="flex gap-2">
                          <button type="submit" className="flex-1 bg-primary text-primary-foreground text-xs font-bold py-2 rounded-xl shadow-lg shadow-primary/20">Create</button>
                          <button type="button" onClick={() => setIsCreatingProject(false)} className="flex-1 bg-secondary text-secondary-foreground text-xs font-bold py-2 rounded-xl">Cancel</button>
                        </div>
                      </form>
                    ) : (
                      <button
                        onClick={() => setIsCreatingProject(true)}
                        className="w-full text-left px-3 py-2 text-sm text-primary font-semibold hover:bg-primary/5 rounded-xl flex items-center gap-2 transition-colors"
                      >
                        <Plus size={16} /> New Project
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <button onClick={onClose} className="p-2 hover:bg-accent rounded-xl text-muted-foreground ml-2 transition-colors" title="Close Sidebar">
          <PanelLeftClose size={18} />
        </button>
      </div>

      {/* Action Bar */}
      <div className="px-5 py-3 border-b border-border flex justify-between items-center bg-muted/20">
        <div className="flex bg-muted/50 p-1 rounded-xl border border-border">
          <button 
            onClick={() => setViewMode('business')}
            className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
              viewMode === 'business' 
                ? 'bg-primary text-primary-foreground shadow-md shadow-primary/20' 
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Business
          </button>
          <button 
            onClick={() => setViewMode('snapshot')}
            className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
              viewMode === 'snapshot' 
                ? 'bg-primary text-primary-foreground shadow-md shadow-primary/20' 
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Snapshot
          </button>
        </div>
        <div className="flex gap-1.5">
          <button 
            onClick={() => { setSelectionMode(!selectionMode); setSelectedIds([]); setConfirmDelete(false); }} 
            className={`p-1.5 rounded-lg transition-all ${selectionMode ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/20' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}
            title="Select Multiple"
            disabled={!selectedProjectId}
          >
            <CheckSquare size={16} className={!selectedProjectId ? 'opacity-30' : ''} />
          </button>
          <button 
            onClick={() => onSelectNote('new')} 
            className="p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg transition-all" 
            title="New Note"
            disabled={!selectedProjectId}
          >
            <Plus size={18} className={!selectedProjectId ? 'opacity-30' : ''} />
          </button>
        </div>
      </div>
      
      {selectionMode && (
        <div className="p-3 bg-primary/5 flex justify-between items-center text-xs border-b border-primary/20 animate-in slide-in-from-top duration-200">
          <div className="flex items-center gap-2">
            <button 
              onClick={handleSelectAll}
              className="p-1 hover:bg-primary/20 rounded text-primary transition-colors flex items-center justify-center"
              title={selectedIds.length === notes.length && notes.length > 0 ? "Deselect All" : "Select All"}
            >
              <CheckSquare size={14} className={selectedIds.length === notes.length && notes.length > 0 ? "fill-primary/20" : "opacity-50"} />
            </button>
            <span className="font-bold text-primary">{selectedIds.length} selected</span>
          </div>
          {selectedIds.length > 0 && (
            <button 
              onClick={() => {
                if (confirmDelete) handleBulkDelete();
                else setConfirmDelete(true);
              }} 
              className="bg-destructive text-destructive-foreground px-2 py-1 rounded-md font-bold flex items-center gap-1 shadow-lg shadow-destructive/20"
            >
              <Trash2 size={12} /> {confirmDelete ? 'Confirm?' : 'Delete'}
            </button>
          )}
        </div>
      )}

      <div className="p-3 flex-1 overflow-y-auto custom-scrollbar">
        {!selectedProjectId ? (
          <div className="text-sm text-muted-foreground p-8 text-center opacity-50 italic">Select or create a project to view notes.</div>
        ) : notes.length === 0 ? (
          <div className="text-sm text-muted-foreground p-8 text-center opacity-50 italic">No notes yet. Create one!</div>
        ) : (
          <div className="space-y-1">
            {viewMode === 'snapshot' ? renderSnapshotTree() : renderTree(null)}
          </div>
        )}
      </div>
    </div>
  );
};
