export interface TestWorkspaceFixture {
  id: string;
  name: string;
  slug: string;
}

export interface TestUserFixture {
  id: string;
  email: string;
  name: string;
}

export const FIXTURE_WORKSPACES: { alpha: TestWorkspaceFixture; beta: TestWorkspaceFixture } = {
  alpha: {
    id: 'ws-test-alpha-id',
    name: 'Workspace Alpha',
    slug: 'workspace-alpha',
  },
  beta: {
    id: 'ws-test-beta-id',
    name: 'Workspace Beta',
    slug: 'workspace-beta',
  },
};

export const FIXTURE_USERS: {
  admin: TestUserFixture;
  member: TestUserFixture;
  viewer: TestUserFixture;
  foreign: TestUserFixture;
} = {
  admin: {
    id: 'usr-admin-uuid-0001',
    email: 'admin@alpha.corp',
    name: 'Admin Alpha',
  },
  member: {
    id: 'usr-member-uuid-0002',
    email: 'member@alpha.corp',
    name: 'Member Alpha',
  },
  viewer: {
    id: 'usr-viewer-uuid-0003',
    email: 'viewer@alpha.corp',
    name: 'Viewer Alpha',
  },
  foreign: {
    id: 'usr-foreign-uuid-9999',
    email: 'intruder@other.corp',
    name: 'Intruder Beta',
  },
};
