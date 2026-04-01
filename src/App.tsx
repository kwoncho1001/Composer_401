import React, { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { signInWithGoogle, logout } from './firebase';
import { Sidebar } from './components/Sidebar';
import { NoteEditor } from './components/NoteEditor';
import { GitHubSync } from './components/GitHubSync';
import { 
  LogOut, 
  PanelLeftClose, 
  PanelLeftOpen, 
  PanelRightClose, 
  PanelRightOpen, 
  Moon, 
  Sun,
  Zap,
  Github,
  FolderGit2,
  Folder,
  Layers
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from './firebase';
import { Note } from './types';

function MainApp() {
  const { user, loading: authLoading } = useAuth();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [isLeftOpen, setIsLeftOpen] = useState(true);
  const [isRightOpen, setIsRightOpen] = useState(true);
  const [projectNotes, setProjectNotes] = useState<Note[]>([]);
  const [leftWidth, setLeftWidth] = useState(256); // Default w-64
  const [rightWidth, setRightWidth] = useState(384); // Default w-96
  const [isResizingLeft, setIsResizingLeft] = useState(false);
  const [isResizingRight, setIsResizingRight] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('theme') as 'light' | 'dark' || 'dark';
    }
    return 'dark';
  });

  const handleSignIn = async () => {
    if (isSigningIn) return;
    setIsSigningIn(true);
    try {
      await signInWithGoogle();
    } finally {
      setIsSigningIn(false);
    }
  };

  useEffect(() => {
    if (!user || !selectedProjectId) {
      setProjectNotes([]);
      return;
    }

    const q = query(
      collection(db, 'notes'),
      where('projectId', '==', selectedProjectId),
      where('uid', '==', user.uid)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const notes = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Note[];
      setProjectNotes(notes);
    }, (error) => {
      // handleFirestoreError is not imported in App.tsx, but we can log it
      console.error("Error fetching notes", error);
    });

    return () => unsubscribe();
  }, [user, selectedProjectId]);

  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizingLeft) {
        const newWidth = e.clientX;
        if (newWidth > 160 && newWidth < 480) {
          setLeftWidth(newWidth);
        }
      }
      if (isResizingRight) {
        const newWidth = window.innerWidth - e.clientX;
        if (newWidth > 240 && newWidth < 600) {
          setRightWidth(newWidth);
        }
      }
    };

    const handleMouseUp = () => {
      setIsResizingLeft(false);
      setIsResizingRight(false);
      document.body.style.cursor = 'default';
    };

    if (isResizingLeft || isResizingRight) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingLeft, isResizingRight]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  if (authLoading) {
    return <div className="h-screen flex items-center justify-center bg-background text-foreground">Loading...</div>;
  }

  if (!user) {
    return (
      <div className="h-screen flex items-center justify-center bg-background text-foreground p-4">
        <div className="bg-card p-8 rounded-2xl shadow-xl border border-border text-center max-w-md w-full glass">
          <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-6 glow-primary">
            <div className="w-8 h-8 bg-primary rounded-lg"></div>
          </div>
          <h1 className="text-4xl font-bold mb-3 tracking-tight">Compose</h1>
          <p className="text-muted-foreground mb-10 text-lg">Vibe coding blueprint & sync for solo developers.</p>
          <button 
            onClick={handleSignIn}
            disabled={isSigningIn}
            className="w-full py-4 bg-primary text-primary-foreground rounded-xl font-semibold hover:opacity-90 transition-all active:scale-[0.98] shadow-lg shadow-primary/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSigningIn ? 'Signing in...' : 'Sign in with Google'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-background text-foreground font-sans selection:bg-primary/30 selection:text-primary-foreground">
      {/* Left Sidebar */}
      <AnimatePresence mode="wait">
        {isLeftOpen && (
          <motion.div 
            initial={{ x: -300, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -300, opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-16 bottom-0 left-0 sm:relative sm:top-0 flex border-r border-border bg-secondary/30 group/sidebar z-40 shadow-2xl sm:shadow-none overflow-hidden"
            style={{ width: typeof window !== 'undefined' && window.innerWidth < 640 ? '100%' : leftWidth }}
          >
            <Sidebar 
              onSelectNote={(id) => {
                setSelectedNoteId(id);
                if (window.innerWidth < 640) setIsLeftOpen(false);
              }} 
              selectedNoteId={selectedNoteId} 
              onClose={() => setIsLeftOpen(false)} 
              selectedProjectId={selectedProjectId}
              onSelectProject={(id) => {
                setSelectedProjectId(id);
              }}
            />
            {/* Left Resizer Handle */}
            <div 
              className="hidden sm:flex absolute top-0 -right-1 w-2 h-full cursor-col-resize hover:bg-primary/40 transition-colors z-50 items-center justify-center"
              onMouseDown={(e) => {
                e.preventDefault();
                setIsResizingLeft(true);
              }}
            >
              <div className={`w-[1px] h-full ${isResizingLeft ? 'bg-primary' : 'bg-transparent'}`} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Collapsed Left Bar (Desktop only) */}
      {!isLeftOpen && (
        <div className="hidden sm:flex w-12 bg-secondary/30 border-r border-border flex-col items-center py-4 gap-4">
          <button 
            onClick={() => setIsLeftOpen(true)} 
            className="p-2 text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg transition-colors"
            title="Open Sidebar"
          >
            <PanelLeftOpen size={20} />
          </button>
        </div>
      )}
      
      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 border-b border-border bg-card/50 backdrop-blur-md flex items-center justify-between px-4 sm:px-6 sticky top-0 z-50">
          <div className="flex items-center gap-2 sm:gap-4">
            {/* Mobile Sidebar Toggle */}
            <button 
              onClick={() => setIsLeftOpen(!isLeftOpen)}
              className="p-2 sm:hidden text-muted-foreground hover:bg-muted rounded-xl transition-all active:scale-95"
            >
              {isLeftOpen ? <PanelLeftClose size={20} className="text-primary" /> : <PanelLeftOpen size={20} />}
            </button>

            <div className="flex items-center gap-2 sm:gap-3">
              <div className="w-8 h-8 sm:w-10 sm:h-10 bg-primary rounded-xl sm:rounded-2xl flex items-center justify-center text-primary-foreground shadow-lg shadow-primary/20 glow-primary shrink-0">
                <Zap size={18} className="sm:hidden" fill="currentColor" />
                <Zap size={22} className="hidden sm:block" fill="currentColor" />
              </div>
              <div className="hidden xs:block">
                <h1 className="text-sm sm:text-lg font-black tracking-tighter uppercase italic leading-none">Composer</h1>
                <span className="text-[8px] sm:text-[10px] font-bold text-muted-foreground/60 tracking-[0.2em] uppercase">System Engine</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 sm:gap-4">
            <button 
              onClick={() => setIsRightOpen(!isRightOpen)} 
              className={`p-2 rounded-xl transition-all active:scale-95 border ${
                isRightOpen 
                  ? 'bg-primary text-primary-foreground border-primary shadow-lg shadow-primary/20' 
                  : 'text-primary hover:bg-primary/10 border-primary/20'
              }`}
              title={isRightOpen ? "Close Sync Engine" : "Open Sync Engine"}
            >
              <Github size={18} />
            </button>

            <div className="hidden md:flex bg-muted/50 p-1 rounded-xl border border-border">
              <div className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest bg-primary text-primary-foreground shadow-md shadow-primary/20">
                <Layers size={12} /> Editor
              </div>
            </div>

            <div className="flex items-center gap-1 sm:gap-3 sm:border-l border-border sm:pl-4">
              <button 
                onClick={toggleTheme}
                className="p-2 text-muted-foreground hover:bg-muted rounded-xl transition-all active:scale-95 hidden sm:flex"
                title={theme === 'light' ? 'Switch to Dark' : 'Switch to Light'}
              >
                {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
              </button>
              
              <div className="flex items-center gap-2 sm:gap-3 px-1 sm:px-2 py-1.5 hover:bg-muted rounded-2xl transition-all cursor-pointer group">
                <img 
                  src={user.photoURL || `https://ui-avatars.com/api/?name=${user.displayName}`} 
                  alt="Profile" 
                  className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl border-2 border-border group-hover:border-primary transition-all shadow-md"
                  referrerPolicy="no-referrer"
                />
                <div className="text-right hidden lg:block">
                  <p className="text-xs font-bold leading-none group-hover:text-primary transition-colors">{user.displayName || 'Developer'}</p>
                  <p className="text-[10px] text-muted-foreground/60 mt-0.5">{user.email}</p>
                </div>
              </div>
              
              <button onClick={logout} className="p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive rounded-xl transition-all active:scale-95" title="Sign out">
                <LogOut size={18} />
              </button>
            </div>
          </div>
        </header>
        
        <div className="flex-1 overflow-auto p-4 sm:p-8 lg:p-12 bg-muted/5 relative">
          <div className="max-w-6xl mx-auto w-full h-full">
            <AnimatePresence mode="wait">
              <motion.div 
                key="editor"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="h-full"
              >
                {selectedProjectId ? (
                  <NoteEditor 
                    noteId={selectedNoteId} 
                    projectId={selectedProjectId}
                    onSaved={() => {}} 
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center text-center max-w-md mx-auto">
                    <div className="w-24 h-24 bg-muted rounded-[2.5rem] flex items-center justify-center mb-8 text-muted-foreground/30 shadow-inner">
                      <FolderGit2 size={40} />
                    </div>
                    <h2 className="text-2xl font-bold mb-3 tracking-tight">Initialize Workspace</h2>
                    <p className="text-muted-foreground mb-8 leading-relaxed">Select an existing project from the explorer or create a new one to begin architecting your system.</p>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </main>

      {/* Right Sidebar */}
      {isRightOpen ? (
        <div 
          className="fixed top-16 bottom-0 right-0 sm:relative sm:top-0 border-l border-border bg-card/30 backdrop-blur-xl z-40 animate-in slide-in-from-right duration-300 shadow-2xl sm:shadow-none"
          style={{ width: typeof window !== 'undefined' && window.innerWidth < 640 ? '100%' : rightWidth }}
        >
          {/* Right Resizer Handle */}
          <div 
            className="hidden sm:flex absolute top-0 -left-1 w-2 h-full cursor-col-resize hover:bg-primary/40 transition-colors z-50 items-center justify-center"
            onMouseDown={(e) => {
              e.preventDefault();
              setIsResizingRight(true);
            }}
          >
            <div className={`w-[1px] h-full ${isResizingRight ? 'bg-primary' : 'bg-transparent'}`} />
          </div>
          <GitHubSync onClose={() => setIsRightOpen(false)} projectId={selectedProjectId} />
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <MainApp />
    </AuthProvider>
  );
}
