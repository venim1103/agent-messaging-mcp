#define _GNU_SOURCE
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static int64_t kernel_time_ns(clockid_t clock_id) {
  struct timespec reading;
  if (syscall(SYS_clock_gettime, clock_id, &reading) != 0) {
    perror("clock_gettime");
    exit(2);
  }
  return (int64_t)reading.tv_sec * INT64_C(1000000000) + reading.tv_nsec;
}

static int64_t time_us(struct timeval reading) {
  return (int64_t)reading.tv_sec * INT64_C(1000000) + reading.tv_usec;
}

static int64_t magnitude(int64_t value) {
  return value < 0 ? -value : value;
}

int main(void) {
  const int64_t started = kernel_time_ns(CLOCK_MONOTONIC);
  const int64_t duration_ns = INT64_C(10000000000);
  const int64_t max_sample_ns = INT64_C(1000000);
  const int64_t anomaly_us = INT64_C(10000);
  uint64_t samples = 0, accepted = 0, skipped = 0;
  uint64_t disagreements = 0, offset_jumps = 0, backwards = 0;
  int64_t max_delta_us = 0, max_offset_step_us = 0;
  int64_t previous_offset = 0, previous_monotonic = started;
  alarm(20);

  while (samples < UINT64_C(50000000)) {
    const int64_t before = kernel_time_ns(CLOCK_MONOTONIC);
    if (before - started >= duration_ns) break;
    struct timeval libc_reading, kernel_reading;
    if (gettimeofday(&libc_reading, NULL) != 0
      || syscall(SYS_gettimeofday, &kernel_reading, NULL) != 0) {
      perror("gettimeofday");
      return 2;
    }
    const int64_t realtime = kernel_time_ns(CLOCK_REALTIME);
    const int64_t after = kernel_time_ns(CLOCK_MONOTONIC);
    samples++;
    if (before < previous_monotonic || after < before) backwards++;
    previous_monotonic = after;
    if (after < before || after - before > max_sample_ns) {
      skipped++;
      continue;
    }

    const int64_t delta_us = time_us(libc_reading) - time_us(kernel_reading);
    if (magnitude(delta_us) > max_delta_us) max_delta_us = magnitude(delta_us);
    if (magnitude(delta_us) > anomaly_us) {
      disagreements++;
      if (disagreements <= 4) printf("libc_kernel_delta_us=%" PRId64 "\n", delta_us);
    }
    const int64_t offset = realtime - (before + (after - before) / 2);
    if (accepted) {
      const int64_t step_us = (offset - previous_offset) / 1000;
      if (magnitude(step_us) > max_offset_step_us) max_offset_step_us = magnitude(step_us);
      if (magnitude(step_us) > anomaly_us) {
        offset_jumps++;
        if (offset_jumps <= 4) printf("kernel_offset_step_us=%" PRId64 "\n", step_us);
      }
    }
    previous_offset = offset;
    accepted++;
  }
  alarm(0);
  printf("samples=%" PRIu64 " accepted=%" PRIu64 " skipped=%" PRIu64 "\n", samples, accepted, skipped);
  printf("libc_kernel_anomalies=%" PRIu64 " max_delta_us=%" PRId64 "\n", disagreements, max_delta_us);
  printf("kernel_offset_jumps=%" PRIu64 " max_offset_step_us=%" PRId64 " monotonic_backwards=%" PRIu64 "\n",
    offset_jumps, max_offset_step_us, backwards);
  printf("elapsed_seconds=%.3f\n", (kernel_time_ns(CLOCK_MONOTONIC) - started) / 1e9);
  return disagreements || offset_jumps || backwards || accepted == 0 ? 1 : 0;
}