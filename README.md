# ClipBridge

iOS 与 PC 之间的局域网剪贴板同步工具。无需安装 App，浏览器打开即可使用。

## 功能特点

- **房间隔离**：不同房间号对应不同剪贴板空间，多组设备互不干扰
- **顺序编号**：创建房间自动分配 `1、2、3…` 递增编号
- **扫码加入**：每个房间生成专属二维码，手机扫码即可进入
- **实时同步**：基于 WebSocket，一端输入另一端即时更新
- **可选密码**：创建房间时可设置 PIN，防止同网其他人误入
- **双端部署**：支持软路由 / NAS / PC 常驻运行
- **PWA 支持**：iPhone 可「添加到主屏幕」当轻量 App 使用

## 工作原理

```
┌─────────────┐     局域网      ┌─────────────┐
│  PC 浏览器   │ ◄──────────► │ ClipBridge  │
│  房间 #1    │   WebSocket   │   服务      │
└─────────────┘               └──────┬──────┘
                                     │
┌─────────────┐     扫码/输入房间号   │
│ iPhone 浏览器│ ◄───────────────────┘
│  房间 #1    │
└─────────────┘
```

## 快速开始

### 环境要求

- Node.js >= 18（进程方式部署时需要）
- Docker（容器方式部署时需要）

### 方式一：进程部署（适合 PC 临时使用）

```bash
git clone https://github.com/valv111/valv.git
cd valv
npm install
npm start
```

或使用启动脚本：

```bash
chmod +x start.sh
./start.sh
```

### 方式二：Docker 部署（适合软路由 / NAS 常驻）

```bash
git clone https://github.com/valv111/valv.git
cd valv
docker compose up -d --build
```

查看日志：

```bash
docker compose logs -f
```

停止服务：

```bash
docker compose down
```

### 方式三：docker run 直接启动

本地构建后运行：

```bash
docker build -t clipbridge .
docker run -d \
  --name clipbridge \
  --restart unless-stopped \
  -p 3456:3456 \
  -v clipbridge-data:/app/.data \
  -e ROOM_START=1 \
  clipbridge
```

使用阿里云镜像（需先登录）：

```bash
docker login --username=你的用户名 registry.cn-hangzhou.aliyuncs.com

docker run -d \
  --name clipbridge \
  --restart unless-stopped \
  -p 3456:3456 \
  -v clipbridge-data:/app/.data \
  -e ROOM_START=1 \
  registry.cn-hangzhou.aliyuncs.com/valv/copy:1.0.0
```

常用管理命令：

```bash
# 查看日志
docker logs -f clipbridge

# 停止
docker stop clipbridge

# 删除容器（数据在 volume 里不会丢）
docker rm clipbridge

# 更新镜像后重启
docker pull registry.cn-hangzhou.aliyuncs.com/valv/copy:1.0.0
docker stop clipbridge && docker rm clipbridge
docker run -d --name clipbridge --restart unless-stopped \
  -p 3456:3456 -v clipbridge-data:/app/.data \
  registry.cn-hangzhou.aliyuncs.com/valv/copy:1.0.0
```

自定义端口示例（映射到 8080）：

```bash
docker run -d \
  --name clipbridge \
  --restart unless-stopped \
  -p 8080:3456 \
  -v clipbridge-data:/app/.data \
  registry.cn-hangzhou.aliyuncs.com/valv/copy:1.0.0
```

访问地址：`http://<主机IP>:3456`（或你映射的端口）

## 阿里云镜像自动构建

当前阿里云构建规则为 `tags:release-v$version`，**只有推送 Git 标签才会触发构建**，普通 `git push` 到 `main` 不会构建。

发布新版本流程：

```bash
# 1. 提交代码并推送到 main
git add .
git commit -m "your message"
git -c http.version=HTTP/1.1 push origin main

# 2. 打标签并推送（标签格式必须是 release-vX.Y.Z）
git tag release-v1.0.1
git -c http.version=HTTP/1.1 push origin release-v1.0.1
```

推送 `release-v1.0.1` 后，阿里云会自动构建镜像版本 `1.0.1`，对应地址：

```
registry.cn-hangzhou.aliyuncs.com/valv/copy:1.0.1
```

已发布的标签：

| Git 标签 | 镜像版本 | 说明 |
|----------|----------|------|
| `release-v1.0.0` | `1.0.0` | 首次发布 |
| `release-v1.0.1` | `1.0.1` | 含 docker run 文档 |

> 若希望推送 `main` 分支就自动构建，需在阿里云控制台 → 构建 → 将规则改为分支 `main`，镜像版本填 `latest`。

## 使用方法

1. 在 PC 或软路由上启动服务
2. 浏览器访问 `http://<服务IP>:3456`
3. 点击 **「创建」** 获得房间号（如 `1`）
4. 另一端 **扫码** 或 **输入相同房间号** 后点「加入」
5. 在文本框中输入 / 粘贴内容，另一端实时同步

### PC 端技巧

| 操作 | 快捷键 |
|------|--------|
| 复制到本机剪贴板 | `Ctrl+Shift+C` |
| 从本机剪贴板粘贴 | `Ctrl+Shift+V` |
| 发送并同步 | `Ctrl+Enter` |

可开启「收到对方内容时自动复制到 PC 剪贴板」。

### iOS 端技巧

- 输入内容后自动同步到另一端
- 点击 **「复制到本机」** 将内容写入 iPhone 剪贴板
- Safari → 分享 → **添加到主屏幕**，后续像 App 一样打开

## 部署场景

### 软路由（推荐全家共用）

在路由器上通过 Docker 常驻运行，局域网内所有设备访问：

```
http://192.168.x.x:3456
```

### PC 本地

临时使用时在 PC 上启动，本机访问 `http://localhost:3456`，手机通过局域网 IP 访问。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3456` | 服务监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `ROOM_START` | `1` | 房间编号起始值 |
| `DATA_DIR` | `./.data` | 数据持久化目录 |
| `MAX_TEXT_BYTES` | `524288` | 单条内容最大字节数（512KB） |

示例：从房间 100 开始编号

```bash
ROOM_START=100 docker compose up -d
```

## 项目结构

```
.
├── server.js           # Express + WebSocket 服务端
├── public/
│   ├── index.html      # Web 前端
│   ├── manifest.json   # PWA 配置
│   └── sw.js           # Service Worker
├── docker-compose.yml
├── Dockerfile
├── start.sh
└── package.json
```

## 数据持久化

房间内容和编号计数保存在 `.data/` 目录（已加入 `.gitignore`）。Docker 部署时通过 volume 持久化，重启不丢数据。7 天未更新的房间会自动清理。

## 安全说明

- 设计用于**局域网**环境，请勿直接暴露到公网
- 敏感内容建议为房间设置密码
- 同网段内知道房间号的人可以加入（未设密码时）

## License

MIT
