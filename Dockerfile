FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data
ENV PORT=7000 DATA_DIR=/app/data
EXPOSE 7000
VOLUME ["/app/data"]
CMD ["node", "src/index.js"]
