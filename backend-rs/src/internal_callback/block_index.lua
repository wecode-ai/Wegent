-- SPDX-FileCopyrightText: 2026 Weibo, Inc.
-- SPDX-License-Identifier: Apache-2.0

-- Business IDs are always prefixed, including IDs that resemble metadata.
local function block_id(raw)
    if not raw then return nil end
    local ok, block = pcall(cjson.decode, raw)
    if ok and type(block) == 'table' and type(block.id) == 'string' then
        return block.id
    end
end

-- Inspect and repair the index atomically with respect to other Redis writers.
-- Only unindexed suffixes are transferred into the hash; hits read one block.
local function find_block(blocks_key, index_key, id, ttl)
    local field = 'block:' .. id
    local indexed = redis.call('HMGET', index_key, field, '_watermark', '_watermark_id')
    local position = tonumber(indexed[1])
    if position and position >= 0 then
        local raw = redis.call('LINDEX', blocks_key, position)
        if block_id(raw) == id then return position, raw end
        redis.call('DEL', index_key)
        indexed = {}
    end
    local start = tonumber(indexed[2]) or 0
    if start < 0 then start = 0 end
    if start > 0 and block_id(redis.call('LINDEX', blocks_key, start - 1)) ~= indexed[3] then
        redis.call('DEL', index_key)
        start = 0
    end
    local blocks = redis.call('LRANGE', blocks_key, start, -1)
    if #blocks == 0 then
        if start == 0 then redis.call('DEL', index_key) end
        return nil
    end
    local found_position, found_raw
    for offset, raw in ipairs(blocks) do
        local candidate = block_id(raw)
        if candidate then
            local index = start + offset - 1
            redis.call('HSET', index_key, 'block:' .. candidate, index)
            if candidate == id then found_position, found_raw = index, raw end
        end
    end
    redis.call('HSET', index_key, '_watermark', start + #blocks,
        '_watermark_id', block_id(blocks[#blocks]) or '')
    redis.call('EXPIRE', index_key, ttl)
    return found_position, found_raw
end
