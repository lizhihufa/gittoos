# 青枝（qingzhi）

- **作者**：理智护发
- **邮箱**：lizhihufa@163.com
- **安装包（百度网盘）**：青枝git小工具  
  链接：https://pan.baidu.com/s/1kzrg41M9558oOi0DSV8ynA?pwd=j5tn  
  提取码：`j5tn`
- **许可**：本项目为开源项目，**禁止商用**

---

选一个项目文件夹，在图形界面里完成日常 Git 操作。基于 Tauri 2 + React + TypeScript，通过本机 `git` 命令读写仓库。安装器显示名称为 **青枝**（可自选安装路径；安装时会先卸载已有版本）。

完整操作说明见根目录 [使用说明书.md](./使用说明书.md)；应用内也可点「说明书」。设置 → **关于** 可查看作者邮箱并反馈问题。

## 技术栈

| 层 | 选择 |
|---|---|
| 桌面壳 | Tauri 2（Rust） |
| 界面 | React + TypeScript + Tailwind CSS |
| Git | 本机 `git.exe`（Git for Windows） |

## 主要功能（v1.3.0）

- 打开 / 初始化 / 克隆仓库；多仓库标签页；最近打开
- 未暂存 / 已暂存、整文件与按块暂存、放弃改动、冲突处理
- 提交、修改上次、撤销上次；分支切换/新建/删除/合并/变基；远程检出与删除
- 获取 / 拉取 / 推送（含分叉与无关历史处理弹窗）
- 历史提交图、拣选、软/混合/硬重置；储藏；标签推送与删除
- 终端输出与自定义命令；主题 / 壁纸 / 仓库缓存加速
- GitHub / Gitee：Token 或 Git Credential Manager 登录
- 耗时 Git 后台执行 + 超时看门狗，降低界面「未响应」

完整操作表见 [使用说明书.md](./使用说明书.md)。

## 开发

需要：Node.js、Rust（stable）、Git for Windows、Visual Studio Build Tools（含 C++ 工作负载）、WebView2。

安装包已内嵌 WebView2。若其他电脑仍提示缺少运行时，首次启动会尝试自动安装；也可手动安装：https://go.microsoft.com/fwlink/p/?LinkId=2124703

```bash
npm install
npm run tauri dev
```

打包安装程序（Windows NSIS）：

推荐双击根目录 **`启动打包工具.bat`**（识别当前版本、拟定下一版、进度条一键打包）。也可：

```bash
npm run packager
# 或
npm run build:installer
```

生成文件大约在：

`src-tauri/target/release/bundle/nsis/青枝_1.3.0_x64-setup.exe`

### 升级安装

- 保持 `identifier`（`com.qingzhi.app`）不变；展示名称为 **青枝**（`productName`），可执行文件仍为 `qingzhi.exe`。
- **每次发新包先改版本号**（打包工具会同步改 `package.json`、`tauri.conf.json`、`Cargo.toml`）。
- 安装时可自选路径；若检测到旧版（含早期英文名 `qingzhi`），会先自动卸载再安装；已禁止用旧包降级覆盖新版。
- 安装前请先退出正在运行的青枝。

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
