import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type {
  AuthAccounts,
  AuthProvider,
  BranchInfo,
  CommitInfo,
  GitInfo,
  Identity,
  LargeFileInfo,
  ProviderStatus,
  HostingRepo,
  PublishResult,
  ReleaseItem,
  RemoteBranchInfo,
  RemoteInfo,
  RepoCore,
  RepoExtras,
  RepoSnapshot,
  RepoStatus,
  StashInfo,
  TagInfo,
  UpdateInfo,
} from "./types";

/** HMR / window boot can briefly break Tauri IPC — retry those only. */
function isTransientIpcError(e: unknown): boolean {
  const msg = String(e);
  return /Failed to fetch|IPC custom protocol|Couldn't find callback|not allowed/i.test(
    msg,
  );
}

async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await tauriInvoke<T>(cmd, args);
    } catch (e) {
      last = e;
      if (!isTransientIpcError(e) || attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 180 * (attempt + 1)));
    }
  }
  throw last;
}

export const api = {
  getGitInfo: () => invoke<GitInfo>("get_git_info"),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  importWallpaper: (source: string, slot: "load" | "terminal" = "load") =>
    invoke<string>("import_wallpaper", { source, slot }),
  clearWallpaper: (slot: "load" | "terminal" = "load") =>
    invoke<void>("clear_wallpaper", { slot }),
  listWallpaperEngineWallpapers: () =>
    invoke<
      {
        path: string;
        previewPath: string;
        projectDir: string;
        kind: string;
        label: string;
        source: string;
        weType: string;
      }[]
    >("list_wallpaper_engine_wallpapers"),
  prepareWallpaperEngineMedia: (
    projectDir: string,
    preferVideo: boolean = false,
  ) =>
    invoke<{
      path: string;
      previewPath: string;
      projectDir: string;
      kind: string;
      label: string;
      source: string;
      weType: string;
    }>("prepare_wallpaper_engine_media", { projectDir, preferVideo }),
  clearAppWallpaperFiles: () => invoke<void>("clear_app_wallpaper_files"),
  getSystemHostsPath: () => invoke<string>("get_system_hosts_path"),
  revealSystemHosts: () => invoke<void>("reveal_system_hosts"),
  applySystemHosts: (block: string) =>
    invoke<string>("apply_system_hosts", { block }),
  resolveGithubHosts: () => invoke<string>("resolve_github_hosts"),
  getHostsStatus: () =>
    invoke<{ path: string; managed: boolean }>("get_hosts_status"),
  checkRepository: (path: string) =>
    invoke<boolean>("check_repository", { path }),
  initRepo: (path: string) => invoke<void>("init_repo", { path }),
  cloneRepo: (
    url: string,
    destination: string,
    opts?: { branch?: string | null; depth?: number | null },
  ) =>
    invoke<string>("clone_repo", {
      url,
      destination,
      branch: opts?.branch ?? null,
      depth: opts?.depth ?? null,
    }),
  saveFeaturePermissions: (
    permissions: import("./permissions").FeaturePermissions,
  ) => invoke<void>("save_feature_permissions", { permissions }),
  getFeaturePermissions: () =>
    invoke<import("./permissions").FeaturePermissions>(
      "get_feature_permissions",
    ),
  setupActionsMirror: (path: string, configureSecret = true) =>
    invoke<import("./types").ActionsMirrorSetup>("setup_actions_mirror_cmd", {
      path,
      configureSecret,
    }),
  getActionsMirrorStatus: (path: string) =>
    invoke<import("./types").ActionsMirrorStatus>("get_actions_mirror_status", {
      path,
    }),
  triggerReverseActionsMirror: (path: string) =>
    invoke<string>("trigger_reverse_actions_mirror_cmd", { path }),
  removeActionsMirror: (path: string, push = true) =>
    invoke<string>("remove_actions_mirror_cmd", { path, push }),
  verifyActionsMirror: (path: string) =>
    invoke<import("./types").ActionsMirrorHealth>("verify_actions_mirror_cmd", {
      path,
    }),
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
  listStagedLargeFiles: (path: string, limitBytes?: number) =>
    invoke<LargeFileInfo[]>("list_staged_large_files", {
      path,
      limitBytes: limitBytes ?? null,
    }),
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
  branchRename: (path: string, oldName: string, newName: string) =>
    invoke<string>("branch_rename", { path, oldName, newName }),
  branchSetUpstream: (
    path: string,
    remote: string,
    branch: string,
    localBranch?: string | null,
  ) =>
    invoke<string>("branch_set_upstream", {
      path,
      remote,
      branch,
      localBranch: localBranch ?? null,
    }),
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
  getRebaseTodo: (path: string, onto: string) =>
    invoke<CommitInfo[]>("get_rebase_todo", { path, onto }),
  branchRebaseInteractive: (
    path: string,
    onto: string,
    items: { action: string; hash: string; subject: string }[],
  ) => invoke<string>("branch_rebase_interactive", { path, onto, items }),
  cherryPick: (path: string, hash: string) =>
    invoke<string>("commit_cherry_pick", { path, hash }),
  revertCommit: (path: string, hash: string) =>
    invoke<string>("commit_revert", { path, hash }),
  checkoutCommit: (path: string, hash: string, newBranch?: string | null) =>
    invoke<string>("commit_checkout", {
      path,
      hash,
      newBranch: newBranch ?? null,
    }),
  undoCommit: (path: string) => invoke<string>("undo_commit", { path }),
  resetCommit: (path: string, hash: string, mode: "soft" | "mixed" | "hard") =>
    invoke<string>("reset_commit", { path, hash, mode }),
  abortOperation: (path: string) =>
    invoke<string>("git_abort_operation", { path }),
  continueOperation: (path: string) =>
    invoke<string>("git_continue_operation", { path }),
  skipRebase: (path: string) => invoke<string>("git_skip_rebase", { path }),
  getRemotes: (path: string) => invoke<RemoteInfo[]>("get_remotes", { path }),
  saveRemote: (path: string, name: string, url: string) =>
    invoke<void>("save_remote", { path, name, url }),
  removeRemote: (path: string, name: string) =>
    invoke<string>("remove_remote_cmd", { path, name }),
  fetch: (path: string, remote?: string | null) =>
    invoke<string>("git_fetch", { path, remote: remote ?? null }),
  pull: (path: string, allowUnrelated = false, rebase = false) =>
    invoke<string>("git_pull", { path, allowUnrelated, rebase }),
  push: (
    path: string,
    force = false,
    syncMirror: "gitee" | "github" | null = null,
    remote: string | null = null,
  ) => invoke<string>("git_push", { path, force, syncMirror, remote }),
  addGitignore: (path: string, paths: string[]) =>
    invoke<string>("add_gitignore", { path, paths }),
  getFileCommits: (path: string, file: string, limit = 50) =>
    invoke<CommitInfo[]>("get_file_commits", { path, file, limit }),
  getFileBlame: (path: string, file: string) =>
    invoke<string>("get_file_blame", { path, file }),
  getReflog: (path: string, limit = 80) =>
    invoke<import("./types").ReflogInfo[]>("get_reflog", { path, limit }),
  cleanFiles: (path: string, dryRun = false, includeIgnored = false) =>
    invoke<string>("git_clean", { path, dryRun, includeIgnored }),
  compareRefs: (path: string, left: string, right: string) =>
    invoke<string>("compare_refs_cmd", { path, left, right }),
  applyWorkdirHunk: (path: string, patch: string, reverse = true) =>
    invoke<string>("apply_workdir_hunk", { path, patch, reverse }),
  readRepoFile: (path: string, file: string) =>
    invoke<string>("read_repo_file", { path, file }),
  writeRepoFile: (path: string, file: string, content: string) =>
    invoke<void>("write_repo_file", { path, file, content }),
  createHostingRepo: (
    provider: AuthProvider,
    name: string,
    privateRepo = false,
    description = "",
  ) =>
    invoke<HostingRepo>("create_hosting_repo", {
      provider,
      name,
      private: privateRepo,
      description,
    }),
  publishRemotes: (
    path: string,
    name: string,
    opts: { toGithub?: boolean; toGitee?: boolean; privateRepo?: boolean } = {},
  ) =>
    invoke<string>("publish_remotes", {
      path,
      name,
      toGithub: opts.toGithub ?? false,
      toGitee: opts.toGitee ?? false,
      private: opts.privateRepo ?? false,
    }),
  getCommits: (path: string) => invoke<CommitInfo[]>("get_commits", { path }),
  getCommitPatch: (path: string, hash: string) =>
    invoke<string>("get_commit_patch", { path, hash }),
  getStashes: (path: string) => invoke<StashInfo[]>("get_stashes", { path }),
  createStash: (path: string, message: string, includeUntracked = false) =>
    invoke<string>("create_stash", { path, message, includeUntracked }),
  popStash: (path: string, index: number) =>
    invoke<string>("pop_stash", { path, index }),
  applyStash: (path: string, index: number) =>
    invoke<string>("apply_stash", { path, index }),
  showStash: (path: string, index: number) =>
    invoke<string>("show_stash", { path, index }),
  dropStash: (path: string, index: number) =>
    invoke<string>("drop_stash", { path, index }),
  getTags: (path: string) => invoke<TagInfo[]>("get_tags", { path }),
  tagCreate: (path: string, name: string, message?: string | null) =>
    invoke<void>("tag_create", {
      path,
      name,
      message: message ?? null,
    }),
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
  authSaveOauthConfig: (
    provider: AuthProvider,
    clientId: string,
    clientSecret: string,
  ) =>
    invoke<ProviderStatus>("auth_save_oauth_config", {
      provider,
      clientId,
      clientSecret,
    }),
  authStartBrowser: (provider: AuthProvider) =>
    invoke<import("./types").OauthBegin>("auth_start_browser", { provider }),
  authFinishBrowser: (provider: AuthProvider) =>
    invoke<ProviderStatus>("auth_finish_browser", { provider }),
  authManagerLogin: (provider: AuthProvider) =>
    invoke<ProviderStatus>("auth_manager_login", { provider }),
  authGithubManagerLogin: () =>
    invoke<ProviderStatus>("auth_github_manager_login"),
  authLoginToken: (provider: AuthProvider, token: string) =>
    invoke<ProviderStatus>("auth_login_with_token", { provider, token }),
  authLogout: (provider: AuthProvider) =>
    invoke<ProviderStatus>("auth_sign_out", { provider }),
  authStartDevice: () =>
    invoke<import("./types").GithubDeviceStart>("auth_start_device"),
  authPollDevice: (deviceCode: string) =>
    invoke<import("./types").GithubDevicePollResult>("auth_poll_device", {
      deviceCode,
    }),
  authEnsureCredentials: () =>
    invoke<AuthAccounts>("auth_ensure_creds"),
  authSwitchAccount: (provider: AuthProvider, accountId: string) =>
    invoke<ProviderStatus>("auth_switch_account_cmd", { provider, accountId }),
  authSshStatus: () => invoke<import("./types").SshStatus>("auth_get_ssh_status"),
  authSshGenerate: () =>
    invoke<import("./types").SshStatus>("auth_generate_ssh_key"),
  authSshTest: (provider: AuthProvider) =>
    invoke<import("./types").SshTestResult>("auth_test_ssh", { provider }),

  checkAppUpdate: (currentVersion: string, owner?: string, repo?: string) =>
    invoke<UpdateInfo>("check_app_update", {
      currentVersion,
      owner: owner ?? null,
      repo: repo ?? null,
    }),
  downloadAppUpdate: (assetUrl: string, assetName: string) =>
    invoke<string>("download_app_update", { assetUrl, assetName }),
  launchAppInstaller: (path: string, exitApp = true) =>
    invoke<void>("launch_app_installer", { path, exitApp }),
  publishGithubRelease: (opts: {
    filePath: string;
    tag: string;
    title?: string;
    notes?: string;
    owner?: string;
    repo?: string;
  }) =>
    invoke<PublishResult>("publish_github_release", {
      filePath: opts.filePath,
      tag: opts.tag,
      title: opts.title ?? null,
      notes: opts.notes ?? null,
      owner: opts.owner ?? null,
      repo: opts.repo ?? null,
    }),
  listGithubReleases: (owner?: string, repo?: string, limit?: number) =>
    invoke<ReleaseItem[]>("list_github_releases", {
      owner: owner ?? null,
      repo: repo ?? null,
      limit: limit ?? null,
    }),
  deleteGithubReleaseAsset: (assetId: number, owner?: string, repo?: string) =>
    invoke<void>("delete_github_release_asset", {
      assetId,
      owner: owner ?? null,
      repo: repo ?? null,
    }),
  deleteGithubRelease: (releaseId: number, owner?: string, repo?: string) =>
    invoke<void>("delete_github_release", {
      releaseId,
      owner: owner ?? null,
      repo: repo ?? null,
    }),
  publishGiteeRelease: (opts: {
    filePath: string;
    tag: string;
    title?: string;
    notes?: string;
    owner?: string;
    repo?: string;
  }) =>
    invoke<PublishResult>("publish_gitee_release", {
      filePath: opts.filePath,
      tag: opts.tag,
      title: opts.title ?? null,
      notes: opts.notes ?? null,
      owner: opts.owner ?? null,
      repo: opts.repo ?? null,
    }),
  listGiteeReleases: (owner?: string, repo?: string, limit?: number) =>
    invoke<ReleaseItem[]>("list_gitee_releases", {
      owner: owner ?? null,
      repo: repo ?? null,
      limit: limit ?? null,
    }),
  deleteGiteeReleaseAsset: (
    releaseId: number,
    assetId: number,
    owner?: string,
    repo?: string,
  ) =>
    invoke<void>("delete_gitee_release_asset", {
      releaseId,
      assetId,
      owner: owner ?? null,
      repo: repo ?? null,
    }),
  deleteGiteeRelease: (releaseId: number, owner?: string, repo?: string) =>
    invoke<void>("delete_gitee_release", {
      releaseId,
      owner: owner ?? null,
      repo: repo ?? null,
    }),

  wikiStatus: (platform: string, owner: string, repo: string) =>
    invoke<import("./types").WikiStatus>("wiki_status", {
      platform,
      owner,
      repo,
    }),
  wikiListPages: (platform: string, owner: string, repo: string) =>
    invoke<import("./types").WikiPageInfo[]>("wiki_list_pages", {
      platform,
      owner,
      repo,
    }),
  wikiReadPage: (
    platform: string,
    owner: string,
    repo: string,
    slug: string,
  ) =>
    invoke<string>("wiki_read_page", { platform, owner, repo, slug }),
  wikiWritePage: (
    platform: string,
    owner: string,
    repo: string,
    slug: string,
    content: string,
  ) =>
    invoke<void>("wiki_write_page", {
      platform,
      owner,
      repo,
      slug,
      content,
    }),
  wikiDeletePage: (
    platform: string,
    owner: string,
    repo: string,
    slug: string,
  ) =>
    invoke<void>("wiki_delete_page", { platform, owner, repo, slug }),
  wikiSync: (platform: string, owner: string, repo: string) =>
    invoke<import("./types").WikiStatus>("wiki_sync", {
      platform,
      owner,
      repo,
    }),
  wikiEnable: (platform: string, owner: string, repo: string) =>
    invoke<void>("wiki_enable", { platform, owner, repo }),
  wikiInit: (platform: string, owner: string, repo: string) =>
    invoke<import("./types").WikiStatus>("wiki_init", {
      platform,
      owner,
      repo,
    }),
  wikiCommitPush: (
    platform: string,
    owner: string,
    repo: string,
    message?: string,
  ) =>
    invoke<import("./types").WikiStatus>("wiki_commit_push", {
      platform,
      owner,
      repo,
      message: message ?? null,
    }),
  wikiWebUrl: (platform: string, owner: string, repo: string) =>
    invoke<string>("wiki_web_url", { platform, owner, repo }),
  getPlatformRepoStats: (platform: string, owner: string, repo: string) =>
    invoke<import("./types").PlatformRepoStats>("get_platform_repo_stats", {
      platform,
      owner,
      repo,
    }),
};
