export type NoteType = 'Domain' | 'Module' | 'Logic' | 'Snapshot';
export type NoteStatus = 'Planned' | 'Done' | 'Conflict';
export type NotePriority = 'A' | 'B' | 'C' | 'Done';

export interface ConflictDetail {
  aspect: string;
  design: string;
  code: string;
  impact: string;
}

export interface ConflictDetails {
  summary: string;
  differences: ConflictDetail[];
}

export interface Project {
  id: string;
  name: string;
  repoUrl: string;
  uid: string;
  createdAt: any; // Firestore Timestamp
}

export interface Note {
  id: string;
  projectId: string;
  title: string;
  summary: string;
  components?: string;
  flow?: string;
  io?: string;
  body: string;
  folder: string;
  noteType: NoteType;
  status: NoteStatus;
  priority: NotePriority;
  lastUpdated: any; // Firestore Timestamp
  parentNoteIds: string[];
  childNoteIds: string[];
  relatedNoteIds: string[];
  originPath?: string;
  sha?: string;
  contentHash?: string;
  embedding?: number[];
  uid: string;
  conflictDetails?: ConflictDetails;
}

export interface SyncLedger {
  id: string;
  projectId: string;
  repoUrl: string;
  fileShaMap: Record<string, string>;
  lastSyncedAt: any; // Firestore Timestamp
  uid: string;
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string;
    email?: string | null;
    emailVerified?: boolean;
    isAnonymous?: boolean;
    tenantId?: string | null;
    providerInfo?: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}
