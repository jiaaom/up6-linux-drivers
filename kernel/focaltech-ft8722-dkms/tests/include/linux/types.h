#ifndef FT8722_TEST_TYPES_H
#define FT8722_TEST_TYPES_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
#ifndef min
#define min(a, b) ((a) < (b) ? (a) : (b))
#endif
typedef int16_t s16;
#endif
