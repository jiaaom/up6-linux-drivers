#ifndef FT8722_TEST_UNALIGNED_H
#define FT8722_TEST_UNALIGNED_H
#include <linux/types.h>
static inline u16 get_unaligned_be16(const void *p)
{
	const u8 *b = p;
	return ((u16)b[0] << 8) | b[1];
}
#endif
