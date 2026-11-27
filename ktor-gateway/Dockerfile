FROM gradle:8.14.3-jdk21 AS build
WORKDIR /workspace
COPY . .
RUN gradle --no-daemon clean installDist

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /workspace/build/install/nuvio-smart-gateway/ ./
RUN mkdir -p /app/data
ENV PORT=7860
ENV DATA_DIR=/app/data
EXPOSE 7860
VOLUME ["/app/data"]
CMD ["bin/nuvio-smart-gateway"]
