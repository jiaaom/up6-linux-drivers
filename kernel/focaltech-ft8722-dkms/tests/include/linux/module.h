#ifndef FT8722_TEST_MODULE_H
#define FT8722_TEST_MODULE_H
#include <errno.h>
#define EXPORT_SYMBOL(x)
#define module_param_named(name, var, type, perm)
#define MODULE_PARM_DESC(name, desc)
#define module_param(name, type, perm)
#define MODULE_DESCRIPTION(x)
#define MODULE_AUTHOR(x)
#define MODULE_LICENSE(x)
#define MODULE_VERSION(x)
#define dev_err_ratelimited(dev, ...) ((void)(dev))
#define dev_warn_ratelimited(dev, ...) ((void)(dev))
#define dev_info(dev, ...) ((void)(dev))
#endif
