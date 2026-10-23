# 项目零第三方依赖，不需要 npm install
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY config.example.json ./

# 配置与运行时数据都落在 /app/data，挂一个卷即可持久化（含后台改过的 SMTP 设置）
ENV STAL_DATA_DIR=/app/data
ENV STAL_CONFIG=/app/data/config.json

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "server.js"]
