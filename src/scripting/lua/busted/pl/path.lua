-- Minimal penlight `pl.path` shim. busted.core uses path.dirname for stack-frame
-- trimming; busted.fixtures uses abspath/splitpath/join/normpath (only when a
-- spec calls the `fixtures` API). Paths in Mudlet Web are POSIX-style VFS paths, so
-- the separator handling is intentionally `/`-only.
local path = {}

path.sep = '/'
path.is_windows = false

-- dirname("@/lua/busted/core.lua") -> "@/lua/busted"
function path.dirname(p)
  p = tostring(p)
  return (p:match('^(.*)[/\\][^/\\]*$')) or ''
end

function path.basename(p)
  p = tostring(p)
  return (p:match('[^/\\]*$')) or p
end

function path.extension(p)
  p = tostring(p)
  return (p:match('(%.[^./\\]*)$')) or ''
end

-- VFS paths are already absolute (rooted at /). Strip a chunkname '@' prefix.
function path.abspath(p)
  p = tostring(p)
  if p:sub(1, 1) == '@' then p = p:sub(2) end
  return p
end

-- splitpath -> dir, file (busted.fixtures only consumes the dir part)
function path.splitpath(p)
  p = tostring(p)
  local dir, file = p:match('^(.*)[/\\]([^/\\]*)$')
  if not dir then return '', p end
  return dir, file
end

function path.join(a, b)
  if b == nil or b == '' then return a end
  if a == '' then return b end
  if a:sub(-1) == '/' then return a .. b end
  return a .. '/' .. b
end

-- Collapse './' and 'a/../' segments. Best-effort; busted only normalises
-- fixture paths it never asserts on.
function path.normpath(p)
  p = tostring(p):gsub('\\', '/')
  local parts = {}
  for seg in p:gmatch('[^/]+') do
    if seg == '..' then
      if #parts > 0 and parts[#parts] ~= '..' then table.remove(parts)
      else parts[#parts + 1] = seg end
    elseif seg ~= '.' then
      parts[#parts + 1] = seg
    end
  end
  local prefix = p:sub(1, 1) == '/' and '/' or ''
  return prefix .. table.concat(parts, '/')
end

function path.isfile(p)
  return lfs and lfs.isfile(tostring(p)) or false
end

function path.isdir(p)
  return lfs and lfs.isdir(tostring(p)) or false
end

return path
