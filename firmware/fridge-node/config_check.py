# PlatformIO pre-script: define COLDCHAIN_HAS_CONFIG_H only when include/config.h exists.
# __has_include("config.h") is not reliable here: other libraries on the include path ship a config.h too.
import os

Import("env")  # noqa: F821 (provided by PlatformIO)

if os.path.isfile(os.path.join(env.subst("$PROJECT_INCLUDE_DIR"), "config.h")):  # noqa: F821
    env.Append(CPPDEFINES=["COLDCHAIN_HAS_CONFIG_H"])  # noqa: F821
