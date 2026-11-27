package it.blvckroby.gateway

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.timeout
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.net.InetAddress
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

private val json = Json {
    ignoreUnknownKeys = true
    isLenient = true
    encodeDefaults = true
}

@Serializable
data class Upstream(val manifestUrl: String, val name: String, val addonId: String)

@Serializable
data class GatewayConfig(
    val id: String,
    val upstreams: List<Upstream>,
    val maxStreams: Int = 50,
    val upstreamTimeoutMs: Long = 12_000
)

@Serializable
data class CreateConfigRequest(
    val upstreams: List<String>,
    val maxStreams: Int = 50,
    val upstreamTimeoutMs: Long = 12_000
)

private data class CachedResult(val expiresAt: Long, val streams: List<JsonElement>)

private class ConfigStore(private val file: File) {
    private val lock = Any()
    private val configs = ConcurrentHashMap<String, GatewayConfig>()

    init {
        file.parentFile?.mkdirs()
        if (file.exists()) {
            runCatching {
                json.decodeFromString<List<GatewayConfig>>(file.readText()).forEach {
                    configs[it.id] = it
                }
            }
        }
    }

    fun get(id: String): GatewayConfig? = configs[id]

    fun put(config: GatewayConfig) = synchronized(lock) {
        configs[config.id] = config
        file.writeText(json.encodeToString(configs.values.sortedBy { it.id }))
    }
}

private fun isPrivateAddress(address: InetAddress): Boolean {
    if (address.isAnyLocalAddress || address.isLoopbackAddress ||
        address.isLinkLocalAddress || address.isSiteLocalAddress ||
        address.isMulticastAddress) return true

    val bytes = address.address
    if (bytes.size == 16) {
        if ((bytes[0].toInt() and 0xFE) == 0xFC) return true
        if (bytes.sliceArray(0..9).all { it == 0.toByte() } &&
            bytes[10] == 0xFF.toByte() && bytes[11] == 0xFF.toByte()) {
            return isPrivateAddress(InetAddress.getByAddress(bytes.sliceArray(12..15)))
        }
    }
    return false
}

private fun validatePublicHttps(raw: String): URI {
    val uri = runCatching { URI(raw) }.getOrElse { error("Invalid manifest URL") }
    require(uri.scheme.equals("https", true)) { "Only HTTPS addon manifests are accepted" }
    require(uri.host != null && uri.userInfo == null) {
        "Manifest URL must have a hostname and no embedded credentials"
    }
    val host = uri.host.lowercase()
    require(host != "localhost" && !host.endsWith(".localhost") && !host.endsWith(".local")) {
        "Local hostnames are blocked"
    }
    val addresses = InetAddress.getAllByName(host)
    require(addresses.isNotEmpty() && addresses.none(::isPrivateAddress)) {
        "Private, local or reserved network addresses are blocked"
    }
    return uri
}

private fun encoded(value: String): String =
    URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20")

private fun streamEndpoint(manifestUrl: String, type: String, id: String): String {
    val uri = URI(manifestUrl)
    val basePath = uri.rawPath.removeSuffix("/manifest.json").removeSuffix("/")
    val path = "$basePath/stream/${encoded(type)}/${encoded(id)}.json"
    val query = uri.rawQuery?.let { "?$it" } ?: ""
    return "${uri.scheme}://${uri.rawAuthority}$path$query"
}

private class GatewayService(private val client: HttpClient) {
    private val cache = ConcurrentHashMap<String, CachedResult>()
    private val cacheTtlMs = 20_000L

    suspend fun validateManifest(rawUrl: String): Upstream {
        val uri = validatePublicHttps(rawUrl)
        val response = client.get(uri.toString()) {
            headers.append("User-Agent", "NuvioSmartGateway/0.1")
        }
        require(response.status.value in 200..299) {
            "Manifest returned HTTP ${response.status.value}; redirects are not followed in this MVP"
        }
        val manifest = json.parseToJsonElement(response.bodyAsText()).jsonObject
        val resources = manifest["resources"]?.jsonArray ?: error("Manifest has no resources")
        val hasStream = resources.any { resource ->
            resource.toString() == "\"stream\"" ||
                resource.jsonObject["name"]?.toString() == "\"stream\""
        }
        require(hasStream) { "Addon does not expose the Stremio stream resource" }
        val name = manifest["name"]?.toString()?.trim('"') ?: "Unnamed addon"
        val addonId = manifest["id"]?.toString()?.trim('"') ?: rawUrl
        return Upstream(uri.toString(), name, addonId)
    }

    suspend fun aggregate(config: GatewayConfig, type: String, id: String): List<JsonElement> = coroutineScope {
        val jobs = config.upstreams.map { upstream ->
            async {
                val key = "${upstream.manifestUrl}|$type|$id"
                val now = System.currentTimeMillis()
                cache[key]?.takeIf { it.expiresAt > now }?.let { return@async it.streams }

                runCatching {
                    val endpoint = streamEndpoint(upstream.manifestUrl, type, id)
                    validatePublicHttps(endpoint)
                    val response = client.get(endpoint) {
                        headers.append("User-Agent", "NuvioSmartGateway/0.1")
                        headers.append("Accept", "application/json")
                        timeout { requestTimeoutMillis = config.upstreamTimeoutMs }
                    }
                    if (response.status.value !in 200..299) return@runCatching emptyList()
                    val payload = json.parseToJsonElement(response.bodyAsText()).jsonObject
                    val streams = payload["streams"]?.jsonArray?.toList() ?: emptyList()
                    cache[key] = CachedResult(now + cacheTtlMs, streams)
                    if (cache.size > 1_000) {
                        val oldest = cache.entries.minByOrNull { it.value.expiresAt }
                        if (oldest != null) cache.remove(oldest.key, oldest.value)
                    }
                    streams
                }.getOrDefault(emptyList())
            }
        }

        val all = jobs.awaitAll().flatten()
        val seen = HashSet<String>()
        all.filter { stream ->
            val obj = runCatching { stream.jsonObject }.getOrNull() ?: return@filter false
            val identity = obj["url"]?.toString()
                ?: obj["infoHash"]?.toString()?.plus(obj["fileIdx"]?.toString().orEmpty())
                ?: stream.toString()
            seen.add(identity)
        }.take(config.maxStreams)
    }
}

fun main() {
    val port = System.getenv("PORT")?.toIntOrNull() ?: 7860
    val dataDir = File(System.getenv("DATA_DIR") ?: "/app/data")
    val store = ConfigStore(File(dataDir, "configs.json"))
    val adminToken = System.getenv("ADMIN_TOKEN")?.takeIf { it.isNotBlank() }
    val client = HttpClient(CIO) {
        expectSuccess = false
        followRedirects = false
        install(HttpTimeout) {
            connectTimeoutMillis = 5_000
            socketTimeoutMillis = 12_000
            requestTimeoutMillis = 12_000
        }
    }
    val service = GatewayService(client)

    embeddedServer(Netty, host = "0.0.0.0", port = port) {
        install(ContentNegotiation) { json(json) }
        routing {
            get("/health") {
                call.respond(buildJsonObject {
                    put("ok", true)
                    put("service", "Nuvio Smart Gateway")
                    put("version", "0.1.0")
                })
            }

            get("/manifest.json") {
                call.respond(buildJsonObject {
                    put("id", "it.blvckroby.nuvio.smartgateway")
                    put("version", "0.1.0")
                    put("name", "Nuvio Smart Gateway")
                    put("description", "Parallel aggregator for configured Stremio-compatible addons")
                    put("resources", JsonArray(listOf(json.parseToJsonElement("\"stream\""))))
                    put("types", JsonArray(listOf("movie", "series", "tv", "channel").map { json.parseToJsonElement("\"$it\"") }))
                    put("catalogs", JsonArray(emptyList()))
                    put("behaviorHints", buildJsonObject {
                        put("configurable", true)
                        put("configurationRequired", true)
                    })
                })
            }

            post("/api/config") {
                if (adminToken == null) {
                    call.respond(HttpStatusCode.ServiceUnavailable, mapOf("error" to "Set ADMIN_TOKEN before enabling configuration"))
                    return@post
                }
                val supplied = call.request.headers["X-Admin-Token"] ?: ""
                if (!MessageDigest.isEqual(adminToken.toByteArray(), supplied.toByteArray())) {
                    call.respond(HttpStatusCode.Unauthorized, mapOf("error" to "Invalid admin token"))
                    return@post
                }
                val body = runCatching { call.receive<CreateConfigRequest>() }.getOrElse {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Invalid JSON configuration"))
                    return@post
                }
                if (body.upstreams.isEmpty() || body.upstreams.size > 12) {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Provide between 1 and 12 addon manifest URLs"))
                    return@post
                }
                val validated = coroutineScope {
                    body.upstreams.distinct().map { url ->
                        async { runCatching { service.validateManifest(url) } }
                    }.awaitAll()
                }
                val upstreams = validated.mapNotNull { it.getOrNull() }
                if (upstreams.isEmpty()) {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "No valid addon manifests were found"))
                    return@post
                }
                val config = GatewayConfig(
                    id = UUID.randomUUID().toString().replace("-", "").take(16),
                    upstreams = upstreams,
                    maxStreams = body.maxStreams.coerceIn(5, 100),
                    upstreamTimeoutMs = body.upstreamTimeoutMs.coerceIn(2_000, 20_000)
                )
                store.put(config)
                val publicUrl = System.getenv("PUBLIC_URL")?.trimEnd('/') ?: "http://localhost:$port"
                call.respond(mapOf(
                    "id" to config.id,
                    "manifestUrl" to "$publicUrl/${config.id}/manifest.json",
                    "validAddons" to upstreams.map { it.name },
                    "rejectedCount" to (body.upstreams.distinct().size - upstreams.size)
                ))
            }

            get("/{configId}/manifest.json") {
                val config = store.get(call.parameters["configId"].orEmpty())
                if (config == null) {
                    call.respond(HttpStatusCode.NotFound, mapOf("error" to "Unknown configuration"))
                    return@get
                }
                call.respond(buildJsonObject {
                    put("id", "it.blvckroby.nuvio.smartgateway.configured")
                    put("version", "0.1.0")
                    put("name", "Nuvio Smart Gateway")
                    put("description", "Aggregated streams from ${config.upstreams.size} configured addons")
                    put("resources", JsonArray(listOf(json.parseToJsonElement("\"stream\""))))
                    put("types", JsonArray(listOf("movie", "series", "tv", "channel").map { json.parseToJsonElement("\"$it\"") }))
                    put("catalogs", JsonArray(emptyList()))
                    put("behaviorHints", buildJsonObject {
                        put("configurable", false)
                        put("configurationRequired", false)
                        put("p2p", false)
                    })
                })
            }

            get("/{configId}/stream/{type}/{id}.json") {
                val config = store.get(call.parameters["configId"].orEmpty())
                val type = call.parameters["type"].orEmpty()
                val id = call.parameters["id"].orEmpty()
                if (config == null || type !in setOf("movie", "series", "tv", "channel")) {
                    call.respond(mapOf("streams" to emptyList<JsonElement>()))
                    return@get
                }
                val streams = service.aggregate(config, type, id)
                call.response.headers.append("Cache-Control", "public, max-age=5")
                call.respond(mapOf("streams" to streams))
            }
        }
    }.start(wait = true)
}
