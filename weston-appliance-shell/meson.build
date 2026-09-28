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

# Companion client: a black fullscreen window that takes all input while the
# screen is dark and reports it on stdout (see screensaver/).
if get_option('screensaver')
  dep_wl_client = dependency('wayland-client')
  dep_wl_protocols = dependency('wayland-protocols')
  wl_scanner = find_program(dependency('wayland-scanner', native: true).get_variable(pkgconfig: 'wayland_scanner'))
  xdg_shell_xml = dep_wl_protocols.get_variable(pkgconfig: 'pkgdatadir') / 'stable/xdg-shell/xdg-shell.xml'
  xdg_shell_h = custom_target('xdg-shell-client-header', input: xdg_shell_xml,
    output: 'xdg-shell-client-protocol.h', command: [wl_scanner, 'client-header', '@INPUT@', '@OUTPUT@'])
  xdg_shell_c = custom_target('xdg-shell-protocol-code', input: xdg_shell_xml,
    output: 'xdg-shell-protocol.c', command: [wl_scanner, 'private-code', '@INPUT@', '@OUTPUT@'])
  viewporter_xml = dep_wl_protocols.get_variable(pkgconfig: 'pkgdatadir') / 'stable/viewporter/viewporter.xml'
  viewporter_h = custom_target('viewporter-client-header', input: viewporter_xml,
    output: 'viewporter-client-protocol.h', command: [wl_scanner, 'client-header', '@INPUT@', '@OUTPUT@'])
  viewporter_c = custom_target('viewporter-protocol-code', input: viewporter_xml,
    output: 'viewporter-protocol.c', command: [wl_scanner, 'private-code', '@INPUT@', '@OUTPUT@'])
  executable('appliance-screensaver',
    'screensaver/appliance-screensaver.c', xdg_shell_h, xdg_shell_c, viewporter_h, viewporter_c,
    dependencies: [dep_wl_client, meson.get_compiler('c').find_library('m')],
    install: true)
endif

install_data('tools/appliance-shell-ctl', install_dir: get_option('bindir'),
             install_mode: 'rwxr-xr-x')
