cmake_minimum_required(VERSION 3.16)
project(melonds_web LANGUAGES C CXX)
if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Configure with emcmake cmake")
endif()
set(BUILD_QT_SDL OFF CACHE BOOL "" FORCE)
set(ENABLE_JIT OFF CACHE BOOL "" FORCE)
set(ENABLE_OGLRENDERER OFF CACHE BOOL "" FORCE)
# Current melonDS_w ARM.cpp still references Gdb::WatchptKind when disabled.
# Keep the native stub enabled until that upstream compile guard is fixed.
set(ENABLE_GDBSTUB ON CACHE BOOL "" FORCE)
set(ENABLE_LTO_RELEASE OFF CACHE BOOL "" FORCE)
add_subdirectory(../melonDS_w ${CMAKE_BINARY_DIR}/melonDS)
target_compile_options(core PUBLIC -pthread)
target_compile_options(teakra PUBLIC -pthread)
add_executable(melonds port.cpp platform.cpp ../melonDS_w/src/net/LocalMP.cpp)
target_link_libraries(melonds PRIVATE core)
target_include_directories(melonds PRIVATE ../melonDS_w/src ../melonDS_w/src/net)
target_compile_definitions(melonds PRIVATE GDBSTUB_ENABLED)
target_compile_features(melonds PRIVATE cxx_std_17)
target_compile_options(melonds PRIVATE -pthread)
target_link_options(melonds PRIVATE
  -pthread -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=268435456
  -sERROR_ON_UNDEFINED_SYMBOLS=1 -sWASM_BIGINT=1
  -sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','HEAPU8']
  -sEXPORTED_FUNCTIONS=['_malloc','_free','_web_create','_web_destroy','_web_load_rom','_web_reset','_web_pause','_web_resume','_web_frame','_web_frame_number','_web_register','_web_set_register','_web_read_memory','_web_write_memory','_web_key_mask','_web_save_state','_web_load_state','_web_state_size','_web_state_export','_web_state_import','_web_save_size','_web_save_export','_web_save_import','_web_copy_frame','_web_log_count','_web_log_entry','_web_net_enqueue','_web_net_log_count','_web_net_log_entry']
  -sFILESYSTEM=1 -sNO_EXIT_RUNTIME=1 -sPTHREAD_POOL_SIZE=32)
set_target_properties(melonds PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${PROJECT_SOURCE_DIR}/../web/dist)
