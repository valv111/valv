# ClipBridge

局域网共享剪贴板。同一个局域网内，大家打开同一个网址，任何人输入的文本会实时同步到所有设备，点「复制到本机」即可写入系统剪贴板。也可以扫页面上的二维码快速打开。

## 项目结构

```
.
├── server.js            后端：静态服务 + WebSocket 实时同步 + 二维码接口
├── public/              前端（浏览器直接加载）
│   ├── index.html         页面结构
│   ├── style.css          样式
│   └── app.js             同步 / 二维码 / 交互逻辑
├── test/
│   └── smoke.test.js    冒烟测试（WebSocket 同步 + HTTP 兜底）
├── package.json         依赖与脚本
├── Dockerfile           容器构建
└── docker-compose.yml   一键容器部署
```

## 方式一：进程启动（本机 / 服务器）

需要 Node.js 18 以上。

```bash
npm install      # 首次安装依赖
npm start        # 启动，默认端口 3456
```

启动后终端会打印可访问地址，浏览器打开 `http://<本机IP>:3456` 即可。

常用环境变量（都可省略）：

| 变量 | 说明 | 默认 |
|------|------|------|
| `PORT` | 监听端口 | `3456` |
| `PIN`  | 访问密码，留空则无需密码 | 空 |

示例（自定义端口 + 密码）：

```bash
PORT=8080 PIN=1234 npm start
```

## 方式二：Docker 启动

用 compose 一键构建并后台运行：

```bash
docker compose up -d --build     # 启动
docker compose logs -f           # 看日志
docker compose down              # 停止
```

改端口或加密码时，在命令前带上变量即可：

```bash
PORT=8080 PIN=1234 docker compose up -d --build
```

## 方式三：docker run（不用 compose）

用本地源码先构建镜像，再运行：

```bash
docker build -t clipbridge .        # 构建镜像
docker run -d --name clipbridge --restart unless-stopped \
  -p 3456:3456 \
  clipbridge
```

或直接用现成镜像运行（无需源码）：

```bash
docker run -d --name clipbridge --restart unless-stopped \
  -p 3456:3456 \
  registry.cn-hangzhou.aliyuncs.com/valv/copy:latest
```

改端口或加密码：`-p` 换宿主端口，`-e PIN=` 设密码（容器内部固定 3456）：

```bash
docker run -d --name clipbridge --restart unless-stopped \
  -p 8080:3456 \
  -e PIN=1234 \
  clipbridge
```

容器管理：

```bash
docker logs -f clipbridge     # 看日志
docker stop clipbridge        # 停止
docker rm -f clipbridge       # 删除
```

## 测试

```bash
npm test
```
