// Entry points use the existing LocalMP queues; no second multiplayer backend.
namespace {
std::array<melonDS::LocalMP::HeldPacket, 64> packetControlCache;
unsigned packetControlCount = 0;
}
extern "C" {
EMSCRIPTEN_KEEPALIVE int web_packet_interceptor(int id, int enabled) {
    if (!get(id)) return -1;
    localMP.SetPacketInterceptor(id, enabled != 0); return 0;
}
EMSCRIPTEN_KEEPALIVE int web_packet_routes(int id, int targets) {
    if (!get(id) || targets < 0 || targets > 65535) return -1;
    localMP.SetPacketRoutes(id, targets); return 0;
}
EMSCRIPTEN_KEEPALIVE int web_packet_pending(int id) {
    if (!get(id)) return -1;
    packetControlCount = localMP.CopyHeldPackets(id, packetControlCache.data(), packetControlCache.size());
    return packetControlCount;
}
EMSCRIPTEN_KEEPALIVE int web_packet_entry(int index, melonDS::u32* meta, melonDS::u8* data) {
    if (index < 0 || static_cast<unsigned>(index) >= packetControlCount || !meta || !data) return -1;
    const auto& packet = packetControlCache[index];
    meta[0] = packet.Id; meta[1] = packet.Sender; meta[2] = packet.Type;
    meta[3] = static_cast<melonDS::u32>(packet.Timestamp); meta[4] = packet.Timestamp >> 32;
    meta[5] = packet.Targets; meta[6] = packet.Length;
    if (packet.Length) std::memcpy(data, packet.Payload.data(), packet.Length);
    return packet.Length;
}
EMSCRIPTEN_KEEPALIVE int web_packet_commit(int id, unsigned packetId, int drop, const melonDS::u8* data,
    int length, int targets, double timestamp) {
    if (!get(id) || !(timestamp >= -1 && timestamp <= 9007199254740991.0)) return -1;
    return localMP.CommitPacket(id, packetId, drop != 0, data, length, targets, timestamp);
}
EMSCRIPTEN_KEEPALIVE int web_packet_inject(int id, unsigned type, const melonDS::u8* data,
    int length, double timestamp, int targets) {
    if (!get(id) || !(timestamp >= 0 && timestamp <= 9007199254740991.0) || targets < 0 || targets > 65535) return -1;
    return localMP.InjectPacket(id, type, data, length, static_cast<melonDS::u64>(timestamp), targets);
}
}
