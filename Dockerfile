FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

ENV PORT=3456
ENV HOST=0.0.0.0

EXPOSE 3456

CMD ["node", "server.js"]
