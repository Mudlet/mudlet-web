-- Stubs that LuaGlobal.lua expects at module load.
luaGlobalPath = "/lua"
mudlet = {
  -- GMCP keys merged rather than replaced (see setMergeTables in Bridge.lua).
  -- Re-seeded here because this table replaces the one Bridge.lua made.
  mergeTables = { "Char.Status" },
  translations = {
    interfacelanguage = "en_US",
    -- The direction names Mudlet builds for its interface language at startup
    -- (TLuaInterpreter::setupLanguageData), which translateTable() falls back
    -- to. The interface is English here, so each name is its own translation.
    en_US = (function()
      local t = {}
      for _, d in ipairs({
        "north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest",
        "up", "down", "in", "out",
        "n", "ne", "e", "se", "s", "sw", "w", "nw", "u", "d",
      }) do t[d] = d end
      return t
    end)(),
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
