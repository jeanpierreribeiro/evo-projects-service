export type ActorType = 'user' | 'service' | 'shareSession';

export interface UserActor {
  type: 'user';
  id: string; // Canonical user UUID from evo-auth
  email: string;
  name: string;
  role?: string;
  avatarUrl?: string;
}

export interface ServiceActor {
  type: 'service';
  id: string;
  name: string;
  initiatedByUserId?: string;
  grants?: string[];
  mode?: 'operator_assist' | 'autonomous' | 'customer_agent';
  crmContext?: {
    crmInstanceId: string;
    crmContactId?: string | null;
    crmConversationId?: string | null;
  };
  allowedWorkspaces?: string[];
  allowedTools?: string[];
  canShare?: boolean;
}

export interface ShareSessionActor {
  type: 'shareSession';
  id: string; // Public session ID
  shareId: string;
  taskId: string;
  workspaceId: string;
}

export type Actor = UserActor | ServiceActor | ShareSessionActor;

export type WorkspaceRoleType = 'ADMIN' | 'MEMBER' | 'VIEWER';

export interface AccessContext {
  actor: Actor;
  workspaceId?: string;
  membership?: {
    role: WorkspaceRoleType;
    active: boolean;
  };
}
