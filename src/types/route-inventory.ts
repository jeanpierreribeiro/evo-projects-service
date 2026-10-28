export interface RoutePolicy {
  action: string;
  resource: string;
  minRole?: 'VIEWER' | 'MEMBER' | 'ADMIN';
  sensitive?: boolean;
}

export interface RouteInventoryEntry {
  method: string;
  url: string;
  action: string;
  policy: string;
  isPublic: boolean;
}

export interface McpToolInventoryEntry {
  name: string;
  description: string;
  action: string;
  policy: string;
}
