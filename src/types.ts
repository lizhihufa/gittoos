export interface GitInfo {
  path: string;
  version: string;
}

export interface FileChange {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface RepoStatus {
  path: string;
  branch: string;
  isDetached: boolean;
  ahead: number;
  behind: number;
  /** Ongoing operation: "merge" | "cherry-pick" | "rebase" | "" */
  operation: string;
  changes: FileChange[];
}

export interface RemoteInfo {
  name: string;
  url: string;
}

export interface Identity {
  name: string;
  email: string;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  /** Space-separated parent hashes. */
  parents?: string;
  /** Decoration from git log %d. */
  refs?: string;
}

export interface StashInfo {
  index: number;
  message: string;
}

export interface TagInfo {
  name: string;
  tip: string;
}

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  upstream: string | null;
  tip: string;
}

export interface RemoteBranchInfo {
  name: string;
  remote: string;
  branch: string;
  tip: string;
  hasLocal: boolean;
}

export interface RepoCore {
  status: RepoStatus;
  branches: BranchInfo[];
  remoteBranches: RemoteBranchInfo[];
  identity: Identity;
  remotes: RemoteInfo[];
}

export interface RepoExtras {
  commits: CommitInfo[];
  stashes: StashInfo[];
  tags: TagInfo[];
}

export interface RepoSnapshot {
  status: RepoStatus;
  branches: BranchInfo[];
  remoteBranches: RemoteBranchInfo[];
  commits: CommitInfo[];
  stashes: StashInfo[];
  tags: TagInfo[];
  identity: Identity;
  remotes: RemoteInfo[];
}

export type AuthProvider = "github" | "gitee";

export interface ProviderStatus {
  provider: AuthProvider | string;
  loggedIn: boolean;
  login: string;
  name: string;
  avatarUrl: string;
  clientId: string;
  hasClientId: boolean;
  hasClientSecret: boolean;
}

export interface AuthAccounts {
  github: ProviderStatus;
  gitee: ProviderStatus;
}

export interface OauthBegin {
  provider: string;
  authUrl: string;
  redirectUri: string;
  state: string;
}

export interface GithubDeviceStart {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
}

export interface GithubDevicePollResult {
  status: string;
  message: string;
  account?: ProviderStatus;
}

/** @deprecated use ProviderStatus */
export type GithubStatus = ProviderStatus;
