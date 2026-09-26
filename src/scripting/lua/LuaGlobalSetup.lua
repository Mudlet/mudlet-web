-- Stubs that LuaGlobal.lua expects at module load.
luaGlobalPath = "/lua"
mudlet = {
  -- GMCP keys merged rather than replaced (see setMergeTables in Bridge.lua).
  -- Re-seeded here because this table replaces the one Bridge.lua made.
  mergeTables = { "Char.Status" },
  translations = {
    interfacelanguage = "en_US",
    en_US = {},
  },
  Locale = {
    prefixOk = { message = "[  OK  ]  - " },
    prefixWarn = { message = "[ WARN ]  - " },
    prefixInfo = { message = "[ INFO ]  - " },
    prefixError = { message = "[ ERROR ] - " },
    packageInstallSuccess = { message = "Package %s installed." },
    packageInstallFail = { message = "Couldn't install package: %s - %s" },
    moduleInstallSuccess = { message = "Module %s installed." },
    moduleInstallFail = { message = "Couldn't install module: %s - %s" },
    packageDownloading = { message = "Downloading package from: %s" },
  },
}
toNativeSeparators = function(p) return p end
