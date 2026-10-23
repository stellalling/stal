# STAL · 洛谷比赛订阅通知平台

请注意，本项目使用 `DeepSeek-V4.1-Flash` 辅助完成。

## 快速开始

### 1. 准备

需要 `Node.js 18` 或更高版本。

```bash
git clone https://github.com/stellalling/stal.git stal
cd stal
node server.js
```

打开 <http://127.0.0.1:3000>，**第一个注册的账号自动成为管理员**。

首次启动时如果没有 `config.json`，程序会自动用 `config.example.json` 加一个随机生成的 `sessionSecret` 创建一份。

### 2. 配置 SMTP

以 QQ 邮箱为例。

**方式一：改 `config.json`**

```json
{
  "smtp": {
    "host": "smtp.qq.com",
    "port": 465,
    "user": "你的QQ号@qq.com",
    "pass": "你的QQ邮箱授权码",
    "fromName": "洛谷比赛订阅"
  }
}
```

**方式二：网页**——登录后进 `/admin` →「SMTP / 推送配置」→ 填地址与授权码 → 保存 → 点「测试 SMTP 登录」。 

### 3. 常驻运行

程序自带定时任务，所以只需要把一个进程长驻，不需要额外的 cron。

```bash
# 先把 docker-compose.yml 的 STAL_SMTP_USER / STAL_SMTP_PASS 换成真值
docker compose up -d --build
```

对外服务建议套一层 Nginx 并启用 HTTPS。反代**必须**传 `X-Forwarded-Proto`，程序靠它判断这一跳是不是 HTTPS，才决定给会话 Cookie 加 `Secure`：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### 4. 验收

```bash
curl -s http://127.0.0.1:3000/api/health     # {"ok":true,...}
npm run crawl                                # 抓一次数据
npm run send:dry                             # 演练今晚会推给谁、推几场
```

再在主页点「发送测试邮件」确认自己能收到，就大功告成了。

## License

[MIT](LICENSE)
