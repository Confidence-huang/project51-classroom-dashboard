/*
STM32F413ZH 端的数据生成示例：把四项模拟值编码成与电脑模拟器一致的 JSON。
此文件可在主机用 gcc -DHOST_SIM 编译检查；真正接板时由队长工程调用
app_tick_5s()，并实现 EC200U_PublishMQTT() 的 UART/AT 驱动及超时处理。
它不假设扩展板占用哪组 UART 引脚，也不会自行烧录现有 NUCLEO 固件。
*/
#include <stdint.h>  /* 序号与人数使用固定宽度整数，避免编译器差异。 */
#include <stdio.h>   /* snprintf 返回写入所需字节数，可据此拒绝截断。 */
#include <time.h>    /* 主机模拟构造 ISO 8601 时间；板端应换成已校时 RTC。 */

/* 队长工程提供：把给定字节以 MQTT QoS 1 发布到指定主题，成功返回 0。 */
extern int EC200U_PublishMQTT(const char *topic, const char *body, unsigned length);

/* --- 每次采样生成一条完整快照，再交给 EC200U 驱动发布 --- */
int app_tick_5s(uint32_t seq, const char *captured_at, const char *device_id) {
    char body[320];                                  /* 四项数据和身份字段均留有余量。 */
    const int people = 2 + (int)(seq % 3);          /* 仅供模拟，真实值应取 K230 输出。 */
    const int temperature = 24 + (int)(seq % 4);    /* 仅供模拟，真实值应取温度传感器。 */
    const int humidity = 45 + (int)(seq % 6);       /* 仅供模拟，真实值应取湿度传感器。 */
    const int light = 300 + (int)(seq * 10);        /* 仅供模拟，真实值应取照度传感器。 */

    /* 模拟标记是协议的一部分；接入真实采样后必须显式改为 false。 */
    const int length = snprintf(body, sizeof body,
        "{\"schema_version\":1,\"type\":\"telemetry\",\"source\":\"stm32_sim\","
        "\"simulated\":true,\"device_id\":\"%s\",\"room_id\":\"room01\","
        "\"seq\":%lu,\"captured_at\":\"%s\",\"people_count\":%d,"
        "\"temperature_c\":%d,\"humidity_pct\":%d,\"light_lux\":%d}",
        device_id, (unsigned long)seq, captured_at, people, temperature, humidity, light);
    if (length < 0 || (unsigned)length >= sizeof body) return -1; /* 防止串口发截断 JSON。 */
    return EC200U_PublishMQTT("classroom/room01/telemetry", body, (unsigned)length);
}

#ifdef HOST_SIM
/* --- 主机验收桩：打印将发送的字节，不接触真实模组或云端 --- */
int EC200U_PublishMQTT(const char *topic, const char *body, unsigned length) {
    printf("TOPIC=%s LENGTH=%u\n%.*s\n", topic, length, (int)length, body);
    return 0;
}
int main(void) {
    return app_tick_5s(1, "2026-11-15T00:00:00Z", "nucleo-f413zh-sim01");
}
#endif
