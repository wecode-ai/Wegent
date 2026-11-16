-- All inbox mutations use one atomic Redis operation. Payload JSON stays opaque.
-- Required by Redis 4 when server TIME is followed by writes.
redis.replicate_commands()
local prefix = 'wegent:{git-inbox}:'
local operation = ARGV[1]
local user = ARGV[2]
local input = cjson.decode(ARGV[3])
local now = redis.call('TIME')
local cutoff = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local retention = 30 * 24 * 60 * 60
local function fail(code) return cjson.encode({error=code}) end
local function record(id) return prefix .. 'subscription:' .. id end
local function user_index(uid) return prefix .. 'user:' .. uid end
local function connections(uid) return prefix .. 'connections:' .. uid end
local function subscriptions()
    local entries = redis.call('HGETALL', user_index(user))
    local ids = {}
    for index=1,#entries,2 do
        local id, key = entries[index], entries[index+1]
        if redis.call('EXISTS', record(id)) == 1 then
            table.insert(ids,id)
        else
            redis.call('HDEL', user_index(user), id)
            if redis.call('HGET', connections(user), key) == id then redis.call('HDEL', connections(user), key) end
        end
    end
    return ids
end
if operation == 'list' then return cjson.encode({ids=subscriptions()}) end
if operation == 'create' then
    local existing = redis.call('HGET', connections(user), input.connection_key)
    if existing then
        local raw = redis.call('GET', record(existing))
        if raw then
            local row = cjson.decode(raw)
            if row.active then return cjson.encode({row=row}) end
        end
        redis.call('HDEL', user_index(user), existing)
    end
    subscriptions()
    if redis.call('HLEN', user_index(user)) >= 1000 then return fail('limit') end
    redis.call('SET', KEYS[1], ARGV[3])
    redis.call('HSET', user_index(user), input.id, input.connection_key)
    redis.call('HSET', connections(user), input.connection_key, input.id)
    return cjson.encode({row=input})
end
local raw = redis.call('GET', KEYS[1])
if not raw then return fail('missing') end
local row = cjson.decode(raw)
if user ~= '' and tostring(row.user_id) ~= user then return fail('missing') end
if operation ~= 'get' then
    if not row.active and (operation ~= 'update' or row.secret == '') then return fail('inactive') end
    if operation == 'append' then
        if row.secret ~= input.secret then return fail('changed') end
    elseif row.generation ~= input.generation or (operation ~= 'update' and row.device_id ~= input.deviceId) then
        return fail('changed')
    end
end
-- Queue keys expire together after inactivity. Metadata keeps the last sequence,
-- so Redis expiry/eviction is reported as a gap rather than a silent empty queue.
local previous_gap = row.gap_before
if redis.call('EXISTS', KEYS[2]) == 0 and row.latest_sequence > row.confirmed_sequence then
    row.gap_before = math.max(row.gap_before, row.latest_sequence)
end
local expired = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', cutoff, 'LIMIT', 0, 10000)
for _, sequence in ipairs(expired) do
    if tonumber(sequence) > row.confirmed_sequence then row.gap_before = math.max(row.gap_before, tonumber(sequence)) end
end
-- Persist the gap before deletion, including when the requested operation fails.
if row.gap_before ~= previous_gap then
    redis.call('SET', KEYS[1], cjson.encode(row))
    if not row.active then redis.call('EXPIRE', KEYS[1], retention) end
end
for _, sequence in ipairs(expired) do
    redis.call('ZREM', KEYS[2], sequence)
    redis.call('HDEL', KEYS[3], sequence)
    redis.call('ZREM', KEYS[4], sequence)
end
local items = {}
if operation == 'update' then
    local owner = redis.call('HGET', connections(user), input.connection_key)
    if owner and owner ~= row.id then return fail('duplicate') end
    redis.call('HDEL', connections(user), row.connection_key)
    row.device_id = input.deviceId
    row.generation = input.nextGeneration
    row.connection_key = input.connection_key
    if input.active ~= nil then row.active = input.active end
    redis.call('HSET', connections(user), row.connection_key, row.id)
    redis.call('HSET', user_index(user), row.id, row.connection_key)
elseif operation == 'remove' then
    row.active = false
    row.secret = ''
    redis.call('HDEL', user_index(user), row.id)
    redis.call('HDEL', connections(user), row.connection_key)
    redis.call('DEL', KEYS[2], KEYS[3], KEYS[4])
elseif operation == 'append' then
    if redis.call('EXISTS', KEYS[5]) == 0 then
        if redis.call('ZCARD', KEYS[2]) >= 10000 then return fail('capacity') end
        row.latest_sequence = row.latest_sequence + 1
        local sequence = tostring(row.latest_sequence)
        redis.call('HSET', KEYS[3], sequence, input.delivery)
        redis.call('ZADD', KEYS[2], row.latest_sequence, sequence)
        redis.call('ZADD', KEYS[4], cutoff + retention * 1000, sequence)
        redis.call('SET', KEYS[5], sequence, 'EX', retention)
        for index=2,4 do redis.call('EXPIRE', KEYS[index], retention) end
        row.last_received_at = input.receivedAt
    end
elseif operation == 'ack' then
    if input.sequence > row.latest_sequence then return fail('unknown_ack') end
    if input.sequence > row.confirmed_sequence then
        if redis.call('ZSCORE', KEYS[2], tostring(input.sequence)) == false then return fail('unknown_ack') end
        row.confirmed_sequence = input.sequence
        local confirmed = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', input.sequence)
        for _, sequence in ipairs(confirmed) do
            redis.call('HDEL', KEYS[3], sequence)
            redis.call('ZREM', KEYS[4], sequence)
        end
        redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', input.sequence)
    end
elseif operation == 'events' then
    local sequences = redis.call('ZRANGEBYSCORE', KEYS[2], '(' .. tostring(input.after), '+inf', 'LIMIT', 0, 100)
    for _, sequence in ipairs(sequences) do
        local data = redis.call('HGET', KEYS[3], sequence)
        if not data then return fail('payload_missing') end
        table.insert(items, {sequence=tonumber(sequence),data=data})
    end
end
row.pending_count = redis.call('ZCARD', KEYS[2])
redis.call('SET', KEYS[1], cjson.encode(row))
if not row.active then redis.call('EXPIRE', KEYS[1], retention) end
return cjson.encode({row=row,items=items})
