FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

EXPOSE 4173
CMD ["npm", "start"]
