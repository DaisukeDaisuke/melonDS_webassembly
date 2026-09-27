#include "Platform.h"
#include "LocalMP.h"
#include "virtual-net.h"
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <array>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

namespace melonDS::Platform {
void saveNDSToInstance(const u8*, u32, void*);
LocalMP& localMultiplayer();
static std::mutex netLock;
static std::array<std::deque<WebNetFrame>, 16> netPending;
static std::deque<WebNetFrame> netEvents;
static u32 netDropped = 0;
int WebNetEnqueue(int instanceId, const u8* data, int length) {
    if (instanceId < 0 || instanceId >= 16 || !data || length < 14 || length > 2048) return -1;
    std::lock_guard<std::mutex> lock(netLock);
    if (netPending[instanceId].size() >= 256) return -2;
    WebNetFrame frame {GetUSCount(), instanceId, length, true, {}};
    memcpy(frame.data.data(), data, length);
    netPending[instanceId].push_back(frame);
    return length;
}
void WebNetClear(int instanceId) {
    if (instanceId < 0 || instanceId >= 16) return;
    std::lock_guard<std::mutex> lock(netLock);
    netPending[instanceId].clear();
}
int WebNetDrain(WebNetFrame* out, int capacity, u32* dropped) {
    if (!out || capacity < 0) return -1;
    std::lock_guard<std::mutex> lock(netLock);
    if (dropped) { *dropped = netDropped; netDropped = 0; }
    int count = std::min(capacity, static_cast<int>(netEvents.size()));
    for (int i = 0; i < count; i++) { out[i] = netEvents.front(); netEvents.pop_front(); }
    return count;
}
static void recordNet(const WebNetFrame& frame) {
    if (netEvents.size() >= 512) { netEvents.pop_front(); ++netDropped; }
    netEvents.push_back(frame);
}
struct FileHandle { FILE* stream; };
struct Thread { std::thread worker; };
struct Mutex { std::mutex lock; };
struct Semaphore { std::mutex mutex; std::condition_variable signal; int count = 0; };

void SignalStop(StopReason, void*) {}
std::string GetLocalFilePath(const std::string& name) { return name; }
FileHandle* OpenFile(const std::string& path, FileMode mode) {
    const bool write = mode & Write;
    const bool read = mode & Read;
    const bool exists = FileExists(path);
    if (!read && !write) return nullptr;
    if (write && (mode & NoCreate) && !exists) return nullptr;
    const char* flags = !write ? "rb" : (mode & Append) ? "ab+" :
        ((mode & Preserve) && exists) || (mode & NoCreate) ? "rb+" : read ? "wb+" : "wb";
    auto* stream = fopen(path.c_str(), flags);
    return stream ? new FileHandle {stream} : nullptr;
}
FileHandle* OpenLocalFile(const std::string& path, FileMode mode) { return OpenFile(GetLocalFilePath(path), mode); }
bool FileExists(const std::string& path) { FILE* f = fopen(path.c_str(), "rb"); if (!f) return false; fclose(f); return true; }
bool LocalFileExists(const std::string& path) { return FileExists(GetLocalFilePath(path)); }
bool CheckFileWritable(const std::string& path) {
    FILE* f = fopen(path.c_str(), FileExists(path) ? "ab" : "wb");
    if (!f) return false; fclose(f); return true;
}
bool CheckLocalFileWritable(const std::string& path) { return CheckFileWritable(GetLocalFilePath(path)); }
bool CloseFile(FileHandle* f) { if (!f) return false; bool ok = fclose(f->stream) == 0; delete f; return ok; }
bool IsEndOfFile(FileHandle* f) { return feof(f->stream) != 0; }
bool FileReadLine(char* str, int count, FileHandle* f) { return fgets(str, count, f->stream) != nullptr; }
u64 FilePosition(FileHandle* f) { return ftell(f->stream); }
bool FileSeek(FileHandle* f, s64 offset, FileSeekOrigin origin) {
    return fseek(f->stream, offset, origin == FileSeekOrigin::Start ? SEEK_SET : origin == FileSeekOrigin::Current ? SEEK_CUR : SEEK_END) == 0;
}
void FileRewind(FileHandle* f) { rewind(f->stream); }
u64 FileRead(void* data, u64 size, u64 count, FileHandle* f) { return fread(data, size, count, f->stream); }
bool FileFlush(FileHandle* f) { return fflush(f->stream) == 0; }
u64 FileWrite(const void* data, u64 size, u64 count, FileHandle* f) { return fwrite(data, size, count, f->stream); }
u64 FileWriteFormatted(FileHandle* f, const char* fmt, ...) {
    va_list args; va_start(args, fmt); int result = vfprintf(f->stream, fmt, args); va_end(args);
    return result < 0 ? 0 : result;
}
u64 FileLength(FileHandle* f) {
    const long position = ftell(f->stream);
    fseek(f->stream, 0, SEEK_END);
    const long length = ftell(f->stream);
    fseek(f->stream, position, SEEK_SET);
    return length < 0 ? 0 : length;
}
void Log(LogLevel, const char* fmt, ...) { va_list args; va_start(args, fmt); vfprintf(stderr, fmt, args); va_end(args); }
Thread* Thread_Create(std::function<void()> fn) { return new Thread { std::thread(std::move(fn)) }; }
void Thread_Wait(Thread* t) { if (t && t->worker.joinable()) t->worker.join(); }
void Thread_Free(Thread* t) { if (!t) return; Thread_Wait(t); delete t; }
Semaphore* Semaphore_Create() { return new Semaphore; }
void Semaphore_Free(Semaphore* s) { delete s; }
void Semaphore_Reset(Semaphore* s) { std::lock_guard<std::mutex> lock(s->mutex); s->count = 0; }
void Semaphore_Post(Semaphore* s, int count) {
    { std::lock_guard<std::mutex> lock(s->mutex); s->count += count; }
    s->signal.notify_all();
}
bool Semaphore_TryWait(Semaphore* s, int timeout) {
    std::unique_lock<std::mutex> lock(s->mutex);
    if (!s->signal.wait_for(lock, std::chrono::milliseconds(timeout), [&] { return s->count > 0; })) return false;
    --s->count; return true;
}
void Semaphore_Wait(Semaphore* s) { std::unique_lock<std::mutex> lock(s->mutex); s->signal.wait(lock, [&] { return s->count > 0; }); --s->count; }
Mutex* Mutex_Create() { return new Mutex; }
void Mutex_Free(Mutex* m) { delete m; }
void Mutex_Lock(Mutex* m) { m->lock.lock(); }
void Mutex_Unlock(Mutex* m) { m->lock.unlock(); }
bool Mutex_TryLock(Mutex* m) { return m->lock.try_lock(); }
void Sleep(u64 microseconds) { std::this_thread::sleep_for(std::chrono::microseconds(microseconds)); }
u64 GetUSCount() {
    return std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
u64 GetMSCount() { return GetUSCount() / 1000; }
void WriteNDSSave(const u8* data, u32 len, u32, u32, void* userdata) { saveNDSToInstance(data, len, userdata); }
void WriteGBASave(const u8*, u32, u32, u32, void*) {}
void WriteFirmware(const Firmware&, u32, u32, void*) {}
void WriteDateTime(int, int, int, int, int, int, void*) {}
static int id(void* userdata) { return userdata ? *static_cast<int*>(userdata) : -1; }
void MP_Begin(void* userdata) { if (id(userdata) >= 0) localMultiplayer().Begin(id(userdata)); }
void MP_End(void* userdata) { if (id(userdata) >= 0) localMultiplayer().End(id(userdata)); }
int MP_SendPacket(u8* data, int len, u64 timestamp, void* userdata) { return localMultiplayer().SendPacket(id(userdata), data, len, timestamp); }
int MP_RecvPacket(u8* data, u64* timestamp, void* userdata) { return localMultiplayer().RecvPacket(id(userdata), data, timestamp); }
int MP_SendCmd(u8* data, int len, u64 timestamp, void* userdata) { return localMultiplayer().SendCmd(id(userdata), data, len, timestamp); }
int MP_SendReply(u8* data, int len, u64 timestamp, u16 aid, void* userdata) { return localMultiplayer().SendReply(id(userdata), data, len, timestamp, aid); }
int MP_SendAck(u8* data, int len, u64 timestamp, void* userdata) { return localMultiplayer().SendAck(id(userdata), data, len, timestamp); }
int MP_RecvHostPacket(u8* data, u64* timestamp, void* userdata) { return localMultiplayer().RecvHostPacket(id(userdata), data, timestamp); }
u16 MP_RecvReplies(u8* data, u64 timestamp, u16 mask, void* userdata) { return localMultiplayer().RecvReplies(id(userdata), data, timestamp, mask); }
int Net_SendPacket(u8* data, int len, void* userdata) {
    const int instance = id(userdata);
    if (instance < 0 || instance >= 16 || !data || len < 14 || len > 2048) return 0;
    WebNetFrame frame {GetUSCount(), instance, len, false, {}};
    memcpy(frame.data.data(), data, len);
    std::lock_guard<std::mutex> lock(netLock);
    recordNet(frame);
    return 0; // melonDS platform convention: zero means submitted.
}
int Net_RecvPacket(u8* data, void* userdata) {
    const int instance = id(userdata);
    if (instance < 0 || instance >= 16 || !data) return 0;
    std::lock_guard<std::mutex> lock(netLock);
    auto& pending = netPending[instance];
    if (pending.empty()) return 0;
    WebNetFrame frame = std::move(pending.front()); pending.pop_front();
    memcpy(data, frame.data.data(), frame.length);
    recordNet(frame);
    return frame.length;
}
void Camera_Start(int, void*) {}
void Camera_Stop(int, void*) {}
void Camera_CaptureFrame(int, u32* frame, int width, int height, bool, void*) { std::fill(frame, frame + width * height, 0); }
void Mic_Start(void*) {}
void Mic_Stop(void*) {}
int Mic_ReadInput(s16*, int, void*) { return 0; }
AACDecoder* AAC_Init() { return nullptr; }
void AAC_DeInit(AACDecoder*) {}
bool AAC_Configure(AACDecoder*, int, int) { return false; }
bool AAC_DecodeFrame(AACDecoder*, const void*, int, void*, int) { return false; }
bool Addon_KeyDown(KeyType, void*) { return false; }
void Addon_RumbleStart(u32, void*) {}
void Addon_RumbleStop(void*) {}
float Addon_MotionQuery(MotionQueryType, void*) { return 0.f; }
DynamicLibrary* DynamicLibrary_Load(const char*) { return nullptr; }
void DynamicLibrary_Unload(DynamicLibrary*) {}
void* DynamicLibrary_LoadFunction(DynamicLibrary*, const char*) { return nullptr; }
}
