-- In-process busted runner for mudix.
--
-- busted's own CLI runner (busted/runner.lua) assumes it owns an OS process —
-- it parses `arg`, reads io.stdout, and exits with a status code. None of that
-- exists in wasmoon, so — exactly as Mudlet did for its `runTests` command — we
-- drive busted through its programmatic core API instead and collect results
-- into a plain table the JS side can JSON-encode.
--
-- Usage (from JS):  require('runBusted')({ '/lua/specs/StringUtils_spec.lua' })
-- Returns: {
--   total, passed, failed, errors, pending,
--   failures = { { spec, name, message, trace }, ... },
--   tests    = { { spec, name, status, message? }, ... },  -- every it(), pass or fail
-- }

-- Trim a stack traceback at the first C frame, matching busted's file loaders.
local function getTrace(_filename, info)
  local index = info.traceback and info.traceback:find('\n%s*%[C]')
  if index then info.traceback = info.traceback:sub(1, index) end
  return info
end

return function(specPaths)
  if type(specPaths) == 'string' then specPaths = { specPaths } end

  -- busted is designed to be require()'d once per OS process: busted/init.lua
  -- replaces its own metatable on first call (dropping the __call used to
  -- initialise it), and the core/luassert modules carry one-shot registration
  -- state. To make the runner re-invokable in mudix's long-lived runtime, drop
  -- the whole busted ecosystem from package.loaded so each run re-evaluates from
  -- a clean slate — exactly what a fresh process would do. (runBusted itself is
  -- intentionally left loaded; we're executing inside it.)
  for name in pairs(package.loaded) do
    if name:match('^busted') or name:match('^luassert') or name:match('^pl%.')
        or name == 'say' or name == 'mediator' or name == 'system' then
      package.loaded[name] = nil
    end
  end

  local busted = require('busted.core')()
  require('busted')(busted)

  local results = {
    total = 0, passed = 0, failed = 0, errors = 0, pending = 0,
    failures = {},
    tests = {},
  }

  -- Build a slash-joined name from a test element up to (not including) its file.
  local function fullName(element)
    local names = {}
    local e = element
    while e and e.descriptor and e.descriptor ~= 'file' do
      if e.name then table.insert(names, 1, e.name) end
      e = busted.context.parent(e)
    end
    return table.concat(names, ' / ')
  end

  local function specOf(element)
    local e = element
    while e do
      if e.descriptor == 'file' then return e.name end
      e = busted.context.parent(e)
    end
    return '?'
  end

  -- A failure/error is published while the test is still on the stack, before
  -- the matching { 'test', 'end' }. Stash the message+trace keyed by element so
  -- the test/end handler can attach it.
  local pending = {}

  local function record(element, _parent, message, trace)
    pending[element] = {
      spec = specOf(element),
      name = fullName(element),
      message = message and tostring(message) or '',
      trace = trace and trace.traceback or nil,
    }
  end

  busted.subscribe({ 'failure', 'it' }, record)
  busted.subscribe({ 'error', 'it' }, record)
  -- Errors raised outside an `it` (e.g. in describe/setup or while loading a
  -- file) never produce a { 'test', 'end' }, so count and capture them here.
  busted.subscribe({ 'error' }, function(element, parent, message, trace)
    -- 'it' errors are handled via the per-test path below; everything else is
    -- a hard error outside a test.
    if element and element.descriptor == 'it' then return end
    results.errors = results.errors + 1
    results.failures[#results.failures + 1] = {
      spec = element and specOf(element) or '?',
      name = element and fullName(element) or '(outside test)',
      message = message and tostring(message) or '',
      trace = trace and trace.traceback or nil,
    }
  end)
  busted.subscribe({ 'failure' }, function(element, parent, message, trace)
    if element and element.descriptor == 'it' then return end
    results.errors = results.errors + 1
    results.failures[#results.failures + 1] = {
      spec = element and specOf(element) or '?',
      name = element and fullName(element) or '(outside test)',
      message = message and tostring(message) or '',
      trace = trace and trace.traceback or nil,
    }
  end)

  -- pending("reason") throws a pending object that busted.safe turns into a
  -- { 'pending', 'it' } publish carrying the message. The { 'test', 'end' }
  -- handler below is only told the status, so without this the reason — the
  -- only thing that says whether a skip is an unconfigured fixture or something
  -- this client can never do — was dropped on the floor.
  local pendingReason = {}
  busted.subscribe({ 'pending', 'it' }, function(element, _parent, message)
    pendingReason[element] = message and tostring(message) or ''
  end)

  busted.subscribe({ 'test', 'end' }, function(element, parent, status)
    results.total = results.total + 1
    local message
    if status == 'success' then
      results.passed = results.passed + 1
    elseif status == 'pending' then
      results.pending = results.pending + 1
      message = pendingReason[element]
      pendingReason[element] = nil
    else
      results.failed = results.failed + 1
      local info = pending[element] or {
        spec = specOf(element), name = fullName(element),
        message = '(' .. tostring(status) .. ')',
      }
      results.failures[#results.failures + 1] = info
      message = info.message
    end
    -- One record per test (pass, fail, or pending) so the harness can report
    -- each it() individually, not just the aggregate counts + failures.
    results.tests[#results.tests + 1] = {
      spec = specOf(element),
      name = fullName(element),
      status = status,
      message = message,
    }
    pending[element] = nil
  end)

  -- Register each spec file with busted (same shape its lua file-loader uses).
  for _, p in ipairs(specPaths) do
    local chunk, err = loadfile(p)
    if not chunk then
      results.errors = results.errors + 1
      results.failures[#results.failures + 1] = {
        spec = p, name = '(load error)', message = tostring(err),
      }
    else
      local file = setmetatable({ getTrace = getTrace, rewriteMessage = nil }, {
        __call = chunk,
      })
      busted.executors.file(p, file)
    end
  end

  local execute = require('busted.execute')(busted)
  execute(1, {})
  busted.publish({ 'exit' })

  return results
end
