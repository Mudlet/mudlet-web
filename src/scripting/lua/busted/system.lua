-- Shim for luasystem's `system` module (busted.core requires it for timing).
-- Mudlet Web runs in wasmoon (no luasystem, no real high-res clock binding), so we
-- back gettime/monotime with os.clock() and make sleep a no-op — busted only
-- uses these to stamp element start/end times and compute durations, which the
-- Mudlet Web in-process runner does not assert on.
return {
  gettime = function() return os.clock() end,
  monotime = function() return os.clock() end,
  sleep = function(_) end,
}
