# 青枝（qingzhi）

- **作者**：理智护发
- **邮箱**：lizhihufa@163.com
- **安装包（百度网盘）**：青枝git小工具  
  链接：https://pan.baidu.com/s/1kzrg41M9558oOi0DSV8ynA?pwd=j5tn  
  提取码：`j5tn`
- **许可**：本项目为开源项目，**禁止商用**

---

选一个项目文件夹，在图形界面里完成日常 Git 操作。基于 Tauri 2 + React + TypeScript，通过本机 `git` 命令读写仓库。

完整操作说明见根目录 [使用说明书.md](./使用说明书.md)；应用内也可点「说明书」。设置 → **关于** 可查看作者邮箱并反馈问题。

## 安装

### Windows

1. 下载安装包：`qingzhi_<版本>_x64-setup.exe`（例如 `qingzhi_1.6.5_x64-setup.exe`）
2. 双击运行；可自选安装路径。若已安装旧版会先卸载再安装。
3. 安装包已内嵌 WebView2。若仍提示缺少运行时，首次启动会尝试自动安装；也可手动安装：https://go.microsoft.com/fwlink/p/?LinkId=2124703

安装前请先退出正在运行的青枝。窗口标题仍显示「青枝」。

### Linux（Debian / Ubuntu，推荐 apt）

Linux 安装包为英文名 **`qingzhi`**（`.deb`），例如：

`qingzhi_1.6.3_amd64.deb`

**推荐用 apt 安装**（会自动安装 WebKitGTK 等依赖，一般不必再手动装环境）：

```bash
# 进入 .deb 所在目录后执行
sudo apt update
sudo apt install ./qingzhi_1.6.3_amd64.deb
```

将文件名换成你下载的实际版本即可。

安装后可从应用菜单启动，或在终端运行：

```bash
qingzhi
```

卸载：

```bash
sudo apt remove qingzhi
```

**说明：**

- 建议系统：Ubuntu 22.04+ / Debian 12+（需提供 `libwebkit2gtk-4.1-0`）
- 请用 `apt install ./xxx.deb`，不要只用 `dpkg -i`（后者不会自动装依赖；若已误用，再执行 `sudo apt -f install` 补全）
- 需本机已安装 Git（`sudo apt install git`）

## 技术栈

| 层 | 选择 |
|---|---|
| 桌面壳 | Tauri 2（Rust） |
| 界面 | React + TypeScript + Tailwind CSS |
| Git | 本机 `git`（Windows 为 Git for Windows） |

## 主要功能（v1.6.3）

- 打开 / 初始化 / 克隆（可选分支、浅克隆）；多仓库标签页；最近打开
- 未暂存 / 已暂存、按块/按行暂存与放弃、加入 .gitignore、内置冲突编辑器、冲突继续/变基跳过/放弃
- 提交、修改上次、撤销上次；分支切换/新建/重命名/删除/合并/变基/交互变基（pick/squash/fixup/drop）/设上游
- 获取（可选远程）、拉取（合并/变基）、推送（指定远程 / 同步另一平台 / 强制推送）
- 同步方式可选：应用内再推，或 GitHub Actions 双向镜像（一键安装）
- 历史：搜索、拣选/还原/检出/重置、引用比较、单文件历史、blame、reflog
- 储藏：查看/应用/弹出/丢弃；标签（可附注）；GitHub / Gitee Release 管理
- 终端、主题 / 壁纸、仓库缓存；GitHub / Gitee 登录
- 耗时 Git 后台执行 + 超时看门狗

完整操作表见 [使用说明书.md](./使用说明书.md)。

## 开发

需要：Node.js、Rust（stable）、Git；Windows 另需 Visual Studio Build Tools（C++）与 WebView2。Linux 构建另需 `libwebkit2gtk-4.1-dev` 等（见 Tauri 官方前置依赖）。

```bash
npm install
npm run tauri:dev
```

### 打包

推荐双击根目录 **`启动打包工具.bat`**（改版本、一键打 Windows + Linux、清理缓存）。也可：

```bash
npm run packager
# 或分别：
npm run tauri:build:win
npm run tauri:build:linux   # 需在 Linux / WSL 环境
```

产物位置：

| 平台 | 路径示例 |
|------|----------|
| Windows | `src-tauri/target/release/bundle/nsis/qingzhi_<版本>_x64-setup.exe` |
| Linux | `src-tauri/target/release/bundle/deb/qingzhi_<版本>_amd64.deb` |

### 升级安装

- 保持 `identifier`（`com.qingzhi.app`）不变。
- 安装包文件名均为英文 **qingzhi**；窗口标题仍为 **青枝**；可执行文件为 `qingzhi` / `qingzhi.exe`。
- **每次发新包先改版本号**（打包工具会同步改 `package.json`、`tauri.conf.json`、`Cargo.toml`）。
- Windows：安装时可自选路径；检测到旧版会先卸载再装；已禁止用旧包降级覆盖新版。
- Linux：用 `sudo apt install ./qingzhi_<新版本>_amd64.deb` 覆盖升级。

## 目录

```text
src/                  React 界面
src-tauri/            Tauri 与 Git 命令层
src-tauri/src/git/    status / diff / commit / branch / remote
packager/             一键打包工具页面
启动打包工具.bat      打开打包工具
```

## 说明

写操作串行执行，避免 `.git/index.lock` 冲突。列表类命令使用 `--porcelain` / `-z`，并关闭 `core.quotepath`。凭据交给系统的 Git Credential Manager，应用进程设置 `GIT_TERMINAL_PROMPT=0`。
