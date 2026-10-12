---
title: Windows 上搭一套顺手的开发环境
date: 2026-07-14
tags: [工具链, Windows, 效率]
summary: WSL2 + Windows Terminal + 包管理器的组合拳。记录我从"能用"到"顺手"的完整配置过程，包含踩过的编码与路径坑。
draft: false
---

## 为什么不再死磕纯 Windows

原生 Windows 开发并不是不能用，而是**生态错位**：大量构建工具、脚本、CLI 默认假设 POSIX 环境。`make`、`rsync`、`find` 这些名字在 Git Bash 里能跑，但行为细节总有出入。

WSL2 的出现改变了这个局面：完整的 Linux 内核，配合 Windows 侧的编辑器，基本能做到两边的好处都占。

## 一、WSL2：基础盘

```powershell
# 一条命令装完，重启后自动进入初始化
wsl --install -d Ubuntu-24.04

# 查看状态与版本
wsl -l -v
wsl --status
```

装完之后**第一件事是配置镜像网络**，否则 WSL 里的服务在 Windows 侧访问会有各种奇怪问题。在 `C:\Users\<你>\.wslconfig` 写入：

```ini
[wsl2]
memory=8GB
processors=6
swap=2GB
networkingMode=mirrored      # 关键：让 WSL 与 Windows 共享网络栈
dnsTunneling=true
autoProxy=true
firewall=false
```

> [!TIP]
> `networkingMode=mirrored` 需要 Windows 11 22H2 及以上。开了之后，WSL 里 `localhost:3000` 起的服务，Windows 浏览器直接能访问，不用再折腾端口转发。

### 别把项目放在 `/mnt/c/`

这是新手的头号性能杀手。跨文件系统的 I/O 要走 9P 协议，`npm install` 的耗时常年高出 **3~5 倍**。

```bash
# ✗ 慢
cd /mnt/c/Users/me/projects/my-app && npm install    # 4 分 12 秒

# ✓ 快
cd ~/projects/my-app && npm install                  # 48 秒
```

把代码放在 WSL 自己的文件系统（`/home/you/...`），用 VS Code 的 Remote-WSL 连过去编辑。Windows 侧要访问的话，走 `\\wsl$\Ubuntu-24.04\home\you` 这个 UNC 路径。

## 二、Windows Terminal：告别黑框

配置文件 `settings.json` 里我固定了这几处：

```json
{
  "defaultProfile": "{wsl-ubuntu-guid}",
  "profiles": {
    "defaults": {
      "font": { "face": "JetBrainsMono Nerd Font", "size": 11 },
      "colorScheme": "One Half Dark",
      "opacity": 96,
      "useAcrylic": true,
      "padding": "10, 8",
      "scrollbarState": "hidden"
    }
  },
  "actions": [
    { "command": { "action": "splitPane", "split": "auto" }, "keys": "alt+shift+d" },
    { "command": "commandPalette", "keys": "ctrl+shift+p" }
  ]
}
```

几个真正提升体验的点：

- **Nerd Font**：终端里的图标（`ls` 的目录图标、`git` 分支符号）全靠它，装完记得在 profile 里指定；
- **`alt+shift+d` 分屏**：右边跑 `npm run dev`，左边继续敲命令，不用来回切窗口；
- **`ctrl+shift+p` 命令面板**：比记快捷键可靠。

## 三、包管理器：一次配置，长期省事

Windows 侧的软件用 `winget` / `scoop`，WSL 里用 `apt` + 语言自带的版本管理器。

```powershell
# Windows 侧：批量装常用工具
winget install --id Git.Git -e
winget install --id Microsoft.VisualStudioCode -e
winget install --id Microsoft.PowerToys -e
winget install --id JanDeDobbeleer.OhMyPosh -e
```

```bash
# WSL 侧：Node 用 fnm 而不是 nvm
curl -fsSL https://fnm.vercel.app/install | bash
fnm install 22 && fnm default 22

# 注意：nvm 在 WSL 里启动极慢（每次 shell 启动要多等 1~2 秒）
# fnm 是 Rust 写的，基本无感
```

> [!WARNING]
> `fnm` 需要在 shell 配置里做初始化。用 bash 的话加在 `~/.bashrc`：
> ```bash
> eval "$(fnm env --use-on-cd --shell bash)"
> ```
> `--use-on-cd` 让人一进项目目录就自动切到 `.node-version` 里指定的版本，非常省心。

## 四、那些年踩过的坑

### 1. 换行符把脚本搞坏

Git 默认在 Windows 上把 `LF` 转成 `CRLF`，导致 shell 脚本在 WSL 里报 `bad interpreter: /bin/bash^M`。

```bash
# 全局配置：检出时保持 LF
git config --global core.autocrlf input

# 已经中招的文件批量修复
find . -type f -name "*.sh" -exec sed -i 's/\r$//' {} \;
```

### 2. 中文文件名乱码

Windows 侧终端默认代码页是 GBK。切到 UTF-8：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONUTF8 = "1"
```

或者直接在 Windows Terminal 的 profile 里加 `"environment": { "PYTHONUTF8": "1" }`。

### 3. 端口占用排查

Windows 和 WSL 的端口可能撞车，而且报错信息很难懂。

```powershell
# Windows 侧谁占了 3000
netstat -ano | findstr :3000
taskkill /PID <pid> /F
```

```bash
# WSL 侧
ss -ltnp | grep :3000
```

### 4. 环境变量两边不同步

WSL 默认会把 Windows 的 `PATH` 追加进来，导致偶尔调用到 Windows 版的 `node`。关掉这个行为：

```ini
# /etc/wsl.conf
[interop]
appendWindowsPath = false
```

## 最终状态

| 环节 | 方案 | 收益 |
| --- | --- | --- |
| 运行环境 | WSL2 + 镜像网络 | 原生 Linux 语义，本地互访 |
| 终端 | Windows Terminal + Nerd Font | 分屏、图标、命令面板 |
| Node 版本 | fnm | shell 启动快 1~2s |
| 编辑器 | VS Code + Remote-WSL | 编辑在 Windows，运行在 Linux |
| 包管理 | winget / apt | 迁移机器时一条命令搞定 |

## 小结

环境配置这件事**值得一次性投入**。花一天时间把它弄顺，后面每一周都会还给你几十分钟。判断配置是否到位的标准很简单：

> 换一台新电脑，你能在 30 分钟内恢复到完全相同的开发环境吗？

如果不能，就把配置脚本化、写进仓库。
