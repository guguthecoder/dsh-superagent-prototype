# dsh-superagent-reactive

[![MSP 2026-10-10](https://modelsensingprotocol.github.io/msp-site/badges/msp-2026-10-10.svg)](https://modelsensingprotocol.github.io/msp-site/docs/spec/) [![license](https://img.shields.io/github/license/hxh230802/dsh-superagent-prototype)](LICENSE) [![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)](INSTALL.md) [![contributors](https://img.shields.io/github/contributors/hxh230802/dsh-superagent-prototype)](#贡献者)
<br/>
[![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933?logo=nodedotjs&logoColor=white)](package.json) [![pnpm](https://img.shields.io/badge/pnpm-11.7.0-F69220?logo=pnpm&logoColor=white)](package.json) [![dsh](https://img.shields.io/badge/dsh-%5E0.2.1--alpha.2-5B4B8A)](package.json) [![tests](https://img.shields.io/badge/tests-1202%20cases-6E9F18?logo=vitest&logoColor=white)](tests)

> **ReActive** 是 [DeepSeek 的 dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 的一个 fork。
> 它保留原型的全部多任务调度能力，补上了原型里缺的两件事：**本机感知**（MSP）与**经验**（Experience）。

论文：[`paper/ReActive-is-All-PA-Need.pdf`](paper/ReActive-is-All-PA-Need.pdf)

---

## 为什么要这个 fork

原型的感知是**轮询**（`src/sources/poll.ts`：14 天窗口，游标回退 5 秒），
来源只有 GitHub 与飞书——两个都在云上，有 API、有配额。

但在本机，软件不会给你 webhook。所以这个 fork 加了一个 Source：

| | 原型 | 本 fork |
|---|---|---|
| 感知方式 | 轮询远端 | **MSP 推送**（`@node.on("**")`） |
| 拓扑 | AI 是中心，软件等它来问 | 网状，软件主动说 |
| 经验 | 无（`grep -ri experience src/` 零结果） | **有**：`~/.dsh/tacit/experiences/*.md` |

## 加了什么

```
src/sources/msp.ts               MSP → Trigger（推送，不轮询）· 无人称 actor
src/sources/msp-act.ts           接入的另一半：看得见节点、发得出信号、调得动工具
src/sources/experiences.ts       读经验库，按信号路径命中才注入
src/sources/experience-tools.ts  经验 CRUD（list/read/create/update/disable）
python/msp_bridge.py             MSP 信号 → 每行一条 JSON
tests/msp.test.mjs               8 项
tests/msp-act.test.ts            10 项
```

**对原型的改动：3 个文件各 1~6 行（登记），其余是新增。** 原有逻辑一行未动。


## 安装

> **让 AI 替你装**：把这句话发给你的 Agent ——「读 INSTALL.md，装好 dsh-superagent-reactive」。
>
> 或者一条命令：

## 一键安装

**桌面端（推荐）**：设置 → 插件 → 装 `github:hxh230802/dsh-superagent-prototype`，然后重启桌面端。

`stateDir` 有默认值（`<DSH home>/state/superagent`），装完侧栏就有 **Superagent**，不需要 Python、tmux，也不用另外起一个 web 服务。代价是它和你日常用的 profile 共用一个进程（bundle 会改这个进程的 `PATH` 和 worker 的 git 配置）；在意隔离就用下面的独立 profile。

**独立 profile（服务器部署 / 想要干净实例）**：

```sh
python scripts/dsh-superagent init     # 建 profile、装 bundle、写 stateDir、起服务、打印地址
```

## 跑法（手动）

部署脚本 `scripts/dsh-superagent` 已经跨平台：POSIX 用 `flock` + `tmux`，Windows 用 `msvcrt` 锁 + 隐藏控制台进程 + `Ctrl+C` 投递。两边命令一样：

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
scripts/dsh-superagent start
```

Windows 上把 `scripts/dsh-superagent` 用 `python` 跑（没有 shebang 支持）：

```powershell
python scripts/dsh-superagent start
python scripts/dsh-superagent status
python scripts/dsh-superagent stop
```

> Windows 上的已知限制：进程发现只看本脚本写的 `service.pid`（没有 `ps` 可扫），所以**用别的命令手动拉起的服务，`status` 看不见**；`stop` 走的是控制台 `Ctrl+C`，服务必须由本脚本启动才停得掉。

两个部署细节：

1. **`stateDir` 可以留空**，默认 `<DSH home>/state/superagent`，设了 `DSH_HOME` 它跟着变。要换位置才写：
   ```yaml
   # ~/.dsh/profiles/superagent/cordis.patch.yml
   - id: dsh-superagent
     config:
       stateDir: "/root/.dsh/state/superagent"
   ```
   两个 profile 同时跑 dsh-superagent，必须给不同的 `stateDir`。
2. **`start` 之前会先看状态锁**：上一个实例被强杀时，`proper-lockfile` 的锁要 30 秒才过期，期间启动会报 `Lock file is already being held`。新版脚本会自己等；老版本删掉 `<stateDir>.lock` 目录再启动。


## Windows 原生（实测可用）

这个 fork **不需要 WSL**。它的服务脚本本来就有完整的 Windows 分支
（`msvcrt.locking` 文件锁、`kernel32.OpenProcess` 查进程、隐藏控制台代替 tmux、Ctrl+C relay 代替 SIGINT）。

```powershell
# 1. 依赖
npm install -g @deepseek-ai/dsh@0.2.1-rc.3

# 2. 建 profile（一次性）
dsh superagent --from-default-profile web --dump-config > $null
dsh plugin --profile superagent add "link:$PWD"

# 3. 启动（stateDir 有默认值，不用再手写）
python scripts/dsh-superagent start
```

实测输出：

```
pids: [66812]
dsh web: http://127.0.0.1:3080/?token=...
```

**唯一坑**：别和 WSL 里的实例同时跑。WSL 的端口转发会占住 `127.0.0.1:3080`，
而 `Get-NetTCPConnection` 看不见它（在 WSL relay 里）。遇到 `EADDRINUSE` 就 `wsl --shutdown`。

## 踩坑记录（都是我自己踩的）

| 症状 | 真因 | 修法 |
|---|---|---|
| `ModuleNotFoundError: fcntl` | 用 `bash` 跑了 Python 脚本，且文件是 CRLF | 用 `python scripts/dsh-superagent`，不要让 bash 执行它 |
| `EADDRINUSE 127.0.0.1:3080` | WSL 实例占着端口 | `wsl --shutdown` 或换端口 |
| 面板显示"没有响应" | 上一个实例被强杀，`proper-lockfile` 的锁还没过期（30 秒） | 等 30 秒，或删掉 `<stateDir>.lock` 目录；新版 `start` 会自己等 |
| `spawn python ENOENT` | 只有 `python3`，没有 `python` | `ln -s python3 /usr/local/bin/python`（Windows 上通常自带 `python`） |
| `bridge exited (2)` | 旧版（带 Python 桥的分支）缺 `msp-py` | 换到 main：桥已移除，用 `msp-ts` |
| 信号收到但 `received: 0` | 我把 `ctx.receive()` 的异常吞了 | 改成写进 health，面板才看得见 |

## 经验长什么样

一条一个 `.md`，`条件 + 动作 + 理由`：

```yaml
---
id: installer-ask
trigger: file.**
condition: true
action: 不要安装，先问这个人装不装、装到哪
trust_level: L3
enabled: true
---
# 下载到安装包时先问
安装包跑起来就有副作用，而且不可逆。
```

**只有命中的经验会进评估上下文**——所以经验越攒越多，提示词不会越来越长。
模型可以通过 `experience_create` 自己写，但**新建最高只能 L3**：L1/L2 是「不用问就动手」，
不能由模型自己授予。

## 状态

- MSP → Trigger → Engine：**通**（实测收到多条信号，`received` 计数递增）
- 经验命中注入：**通**（日志：`经验 installer-ask,zip-archive`）
- 经验 → 行为改变：**未验证**——Eval 目前对这批信号不开单，瓶颈在决策阈值，不在经验供给

最后一条是诚实的：这条链的末端还没接上。

测试（`pnpm test`，Windows 实测）：1202 个用例，1153 通过 / 42 失败 / 7 跳过。失败集中在 `service-script`、`sources`、`environment`、`deployment`（POSIX 语义：文件权限位、PATH 改写、shell shim）和 `docs`（007 文档的模块表、测试表没列全）。Linux 上未实测——徽章里的 `1202 cases` 是用例数，不是通过率。

## 贡献者

<!-- contributors:start -->
<!-- 由 scripts/contributors.mjs 生成，名单看 contributors.json；CI 刷新，勿手改本块 -->

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/hxh230802"><img src="https://avatars.githubusercontent.com/u/106608151?v=4" width="72" height="72" alt="hxh230802" title="hxh230802 · 维护者 · 59 次提交" /></a>
      <br />
      <sub><b>hxh230802</b></sub>
      <br />
      <sub>维护者 · 59 次提交</sub>
    </td>
    <td align="center">
      <a href="https://github.com/Linjiangxian0203"><img src="https://avatars.githubusercontent.com/u/149987761?v=4" width="72" height="72" alt="Linjiangxian0203" title="Linjiangxian0203 · 维护者 · 1 次提交" /></a>
      <br />
      <sub><b>Linjiangxian0203</b></sub>
      <br />
      <sub>维护者 · 1 次提交</sub>
    </td>
    <td align="center">
      <a href="https://github.com/guguthecoder"><img src="https://avatars.githubusercontent.com/u/175189242?v=4" width="72" height="72" alt="guguthecoder" title="guguthecoder · 6 次提交" /></a>
      <br />
      <sub><b>guguthecoder</b></sub>
      <br />
      <sub>6 次提交</sub>
    </td>
    <td align="center">
      <a href="https://github.com/912D"><img src="https://avatars.githubusercontent.com/u/347679655?v=4" width="72" height="72" alt="912D" title="912D · 1 次提交" /></a>
      <br />
      <sub><b>912D</b></sub>
      <br />
      <sub>1 次提交</sub>
    </td>
    <td align="center">
      <a href="https://github.com/apps/github-actions"><img src="https://avatars.githubusercontent.com/in/15368?v=4" width="72" height="72" alt="github-actions[bot]" title="github-actions[bot] · 1 次提交 · 机器人" /></a>
      <br />
      <sub><b>github-actions[bot]</b></sub>
      <br />
      <sub>1 次提交 · 机器人</sub>
    </td>
  </tr>
</table>

共 **5** 位贡献者（含 1 个机器人） · 完整名单见 [graphs/contributors](https://github.com/hxh230802/dsh-superagent-prototype/graphs/contributors)。
<!-- contributors:end -->

> 这块由 CI 维护：[`contributors.yml`](.github/workflows/contributors.yml) 在 push 到 `main` 和每周一各刷一次，内容没变就不提交。
> 名单在 [`contributors.json`](contributors.json)：`repo` 写统计哪个仓库，`people[]` 里 `name` 必填，`login` / `url` / `avatar` / `note` / `maintainer` 选填。`maintainer: true` 的人排最前，多个维护者按 JSON 里的顺序（加入顺序）。
> 带 `login` 的自动从 API 取提交数；API 里出现、声明里没写的新人会自动追加，所以不会漏。

图里只有一个头像和一个提交数，谁做过什么写不下，人工维护：

| 谁 | 做了什么 |
|---|---|
| [@hxh230802](https://github.com/hxh230802) | 这个 fork 的全部主体：MSP Source、经验库与 CRUD 工具、经验注入评估上下文、跨平台服务脚本、这份 README |
| [@guguthecoder](https://github.com/guguthecoder) | [#1](https://github.com/hxh230802/dsh-superagent-prototype/pull/1)：修好类型门（两个文件 14 处），主 Session 只保留 profile 真有的工具，Windows 上不再建不出 Session；[#3](https://github.com/hxh230802/dsh-superagent-prototype/pull/3)：经验工具的 id 统一走 `fileOf` 校验，并修替换串注入与 CRLF 停用两处写入；[#4](https://github.com/hxh230802/dsh-superagent-prototype/pull/4)：Windows 上会挂的几个测试套件跟上这版的新默认值与探测方式；[#8](https://github.com/hxh230802/dsh-superagent-prototype/pull/8)：`*.test.*` 接入 `pnpm check`，不再有跑不到的测试 |
| [@912D](https://github.com/912D) | `src/sources/msp-act.ts`：MSP 的接入另一半——`msp_nodes` / `msp_publish` / `msp_call` 三条工具，让接一台新设备不用改代码；同批 10 项测试 |
| [@Linjiangxian0203](https://github.com/Linjiangxian0203) | [#2](https://github.com/hxh230802/dsh-superagent-prototype/pull/2)：把「被当成自己账号发的事件而丢弃」的条数写进 GitHub 来源的 health，单账号部署不再是无迹可循的死胡同；`docs/known-issues.md` 的 K7 与部署排查表同批补上 |

## 致谢

上游 [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) 的作者（DeepSeek Harness Team）：多任务调度、准入与执行这一整层底座是他们写的。
**他们不是这个仓库的贡献者**，所以不在上面的墙里；但没有他们就没有这个 fork。

## 许可证

MIT，与上游一致。上游 `deepseek-ai/dsh-superagent-prototype` 保留为 `upstream` remote。

> Python 桥已从这个分支移除；需要它的版本见分支 `legacy/python-bridge`。
