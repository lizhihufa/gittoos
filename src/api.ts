import { invoke } from "@tauri-apps/api/core";
import type {
  AuthAccounts,
  AuthProvider,
  BranchInfo,
  CommitInfo,
  GitInfo,
  Identity,
  ProviderStatus,
  RemoteBranchInfo,
  RemoteInfo,
  RepoCore,
  RepoExtras,
  RepoSnapshot,
  RepoStatus,
  StashInfo,
  TagInfo,
} from "./types";

export const api = {
  getGitInfo: () => invoke<GitInfo>("get_git_info"),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  importWallpaper: (source: string) =>
    invoke<string>("import_wallpaper", { source }),
  clearWallpaper: () => invoke<void>("clear_wallpaper"),
  checkRepository: (path: string) =>
    invoke<boolean>("check_repository", { path }),
  initRepo: (path: string) => invoke<void>("init_repo", { path }),
  cloneRepo: (url: string, destination: string) =>
    invoke<string>("clone_repo", { url, destination }),
  getStatus: (path: string) => invoke<RepoStatus>("get_status", { path }),
  getStatusLight: (path: string) =>
    invoke<RepoStatus>("get_status_light", { path }),
  getRepoCore: (path: string) => invoke<RepoCore>("get_repo_core", { path }),
  getRepoExtras: (path: string) =>
    invoke<RepoExtras>("get_repo_extras", { path }),
  getRepoSnapshot: (path: string) =>
    invoke<RepoSnapshot>("get_repo_snapshot", { path }),
  stageFiles: (path: string, paths: string[]) =>
    invoke<void>("stage_files", { path, paths }),
  unstageFiles: (path: string, paths: string[]) =>
    invoke<void>("unstage_files", { path, paths }),
  discardFiles: (path: string, paths: string[]) =>
    invoke<void>("discard_files", { path, paths }),
  getDiff: (path: string, file: string, staged: boolean) =>
    invoke<string>("get_diff", { path, file, staged }),
  applyPatch: (path: string, patch: string, reverse: boolean) =>
    invoke<string>("apply_patch", { path, patch, reverse }),
  getIdentity: (path: string) => invoke<Identity>("get_identity", { path }),
  setIdentity: (path: string, name: string, email: string, global: boolean) =>
    invoke<void>("set_identity", { path, name, email, global }),
  createCommit: (path: string, message: string) =>
    invoke<string>("create_commit", { path, message }),
  amendCommit: (path: string, message: string) =>
    invoke<string>("amend_last_commit", { path, message }),
  getBranches: (path: string) => invoke<BranchInfo[]>("get_branches", { path }),
  getRemoteBranches: (path: string) =>
    invoke<RemoteBranchInfo[]>("get_remote_branches", { path }),
  branchCreate: (path: string, name: string) =>
    invoke<void>("branch_create", { path, name }),
  branchCheckout: (path: string, name: string) =>
    invoke<void>("branch_checkout", { path, name }),
  remoteBranchCheckout: (path: string, name: string) =>
    invoke<string>("remote_branch_checkout", { path, name }),
  remoteBranchDelete: (path: string, name: string) =>
    invoke<string>("remote_branch_delete", { path, name }),
  branchDelete: (path: string, name: string, force: boolean) =>
    invoke<string>("branch_delete", { path, name, force }),
  branchMerge: (path: string, name: string) =>
    invoke<string>("branch_merge", { path, name }),
  branchRebase: (path: string, onto: string) =>
    invoke<string>("branch_rebase", { path, onto }),
  cherryPick: (path: string, hash: string) =>
    invoke<string>("commit_cherry_pick", { path, hash }),
  undoCommit: (path: string) => invoke<string>("undo_commit", { path }),
  resetCommit: (path: string, hash: string, mode: "soft" | "mixed" | "hard") =>
    invoke<string>("reset_commit", { path, hash, mode }),
  abortOperation: (path: string) =>
    invoke<string>("git_abort_operation", { path }),
  continueOperation: (path: string) =>
    invoke<string>("git_continue_operation", { path }),
  getRemotes: (path: string) => invoke<RemoteInfo[]>("get_remotes", { path }),
  saveRemote: (path: string, name: string, url: string) =>
    invoke<void>("save_remote", { path, name, url }),
  fetch: (path: string) => invoke<string>("git_fetch", { path }),
  pull: (path: string, allowUnrelated = false) =>
    invoke<string>("git_pull", { path, allowUnrelated }),
  push: (path: string, force = false) =>
    invoke<string>("git_push", { path, force }),
  getCommits: (path: string) => invoke<CommitInfo[]>("get_commits", { path }),
  getCommitPatch: (path: string, hash: string) =>
    invoke<string>("get_commit_patch", { path, hash }),
  getStashes: (path: string) => invoke<StashInfo[]>("get_stashes", { path }),
  createStash: (path: string, message: string, includeUntracked = false) =>
    invoke<string>("create_stash", { path, message, includeUntracked }),
  popStash: (path: string, index: number) =>
    invoke<string>("pop_stash", { path, index }),
  dropStash: (path: string, index: number) =>
    invoke<string>("drop_stash", { path, index }),
  getTags: (path: string) => invoke<TagInfo[]>("get_tags", { path }),
  tagCreate: (path: string, name: string) =>
    invoke<void>("tag_create", { path, name }),
  tagDelete: (path: string, name: string) =>
    invoke<string>("tag_delete", { path, name }),
  tagPush: (path: string, name: string) =>
    invoke<string>("tag_push", { path, name }),
  tagPushAll: (path: string) => invoke<string>("tag_push_all", { path }),
  tagDeleteRemote: (path: string, name: string) =>
    invoke<string>("tag_delete_remote", { path, name }),
  runCommand: (path: string, command: string) =>
    invoke<string>("run_command", { path, command }),

  authAccounts: () => invoke<AuthAccounts>("auth_get_accounts"),
  authGithubManagerLogin: () =>
    invoke<ProviderStatus>("auth_github_manager_login"),
  authLoginToken: (provider: AuthProvider, token: string) =>
    invoke<ProviderStatus>("auth_login_with_token", { provider, token }),
  authLogout: (provider: AuthProvider) =>
    invoke<ProviderStatus>("auth_sign_out", { provider }),
};
