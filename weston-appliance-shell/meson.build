project('weston-appliance-shell', 'c',
  version: '0.1.0',
  license: 'MIT',
  meson_version: '>= 0.60',
  default_options: ['c_std=gnu11', 'warning_level=2'])

# The module must be built against the same libweston major as the weston
# that loads it; override with -Dlibweston=libweston-15 etc.
libweston_name = get_option('libweston')
dep_libweston = dependency(libweston_name)
dep_weston = dependency('weston', version: dep_libweston.version())
dep_wayland = dependency('wayland-server')

add_project_arguments('-D_GNU_SOURCE', '-Wno-unused-parameter',
                      '-Wno-missing-field-initializers', language: 'c')

moduledir = get_option('moduledir')
if moduledir == ''
  moduledir = get_option('libdir') / 'weston'
endif

shared_module('appliance-shell',
  'src/appliance-shell.c',
  'src/control.c',
  name_prefix: '',
  dependencies: [dep_libweston, dep_weston, dep_wayland],
  install: true,
  install_dir: moduledir)

install_data('tools/appliance-shell-ctl', install_dir: get_option('bindir'),
             install_mode: 'rwxr-xr-x')
