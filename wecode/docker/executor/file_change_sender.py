#!/usr/bin/env python3
"""
File edit log for Claude Code output.
Logs file edit operations with specified fields.
"""
import json
import os
import sys
import uuid
from datetime import datetime

import httpx

WEGENT_EXT_DIR = os.path.expanduser('~/.claude/wegent-extension')


def parse_custom_headers():
    """
    Parse ANTHROPIC_CUSTOM_HEADERS from settings.json file.
    Returns a dict with extracted key-value pairs.
    """
    settings_path = os.path.expanduser('~/.claude/settings.json')
    headers_dict = {}

    try:
        with open(settings_path, 'r', encoding='utf-8') as f:
            settings = json.load(f)
            custom_headers = settings.get('env', {}).get('ANTHROPIC_CUSTOM_HEADERS', '')

            # Parse the newline-separated key-value pairs
            for line in custom_headers.split('\n'):
                line = line.strip()
                if ':' in line:
                    key, value = line.split(':', 1)
                    headers_dict[key.strip()] = value.strip()
    except Exception as e:
        print(f"Warning: Failed to parse custom headers: {e}", file=sys.stderr)

    return headers_dict


def append_to_log(edit_id, stage):
    """
    Append edit ID and timestamp to file_change_sender.log for tracking processing stages.
    
    Args:
        edit_id: The unique ID for this edit operation
        stage: The processing stage description
    """
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    log_filepath = os.path.join(WEGENT_EXT_DIR, 'file_change_sender.log')

    # Ensure the log directory exists
    os.makedirs(WEGENT_EXT_DIR, exist_ok=True)

    # Append log entry
    with open(log_filepath, 'a', encoding='utf-8') as f:
        f.write(f"[{timestamp}] ID: {edit_id} - {stage}\n")


def extract_patch_changes(structured_patch):
    """
    Extract added and deleted lines from structuredPatch.
    
    Args:
        structured_patch: Array of patch objects, each containing 'lines' array
        
    Returns:
        tuple: (code_add_contents, code_delete_contents) - lists of added and deleted content
    """
    code_add_contents = []
    code_delete_contents = []

    for patch in structured_patch:
        lines = patch.get('lines', [])
        for line in lines:
            if line.startswith('+'):
                # Remove the '+' prefix and add to additions
                code_add_contents.append(line[1:] + "\n")
            elif line.startswith('-'):
                # Remove the '-' prefix and add to deletions
                code_delete_contents.append(line[1:] + "\n")

    return code_add_contents, code_delete_contents


def _send_request_sync(payload, headers, edit_id):
    """
    Internal function to send POST request synchronously.
    
    Args:
        payload: The JSON payload to send
        headers: The HTTP headers
        edit_id: The unique ID for this edit operation
    """
    try:
        # Log payload and headers as single-line JSON
        append_to_log(edit_id, f"_send_request_sync: headers={json.dumps(headers, ensure_ascii=False)}")
        append_to_log(edit_id, f"_send_request_sync: payload={json.dumps(payload, ensure_ascii=False)}")

        response = httpx.post(
            'https://copilot.weibo.com/v1/chat/action',
            json=payload,
            headers=headers,
            timeout=30.0
        )
        response.raise_for_status()
        append_to_log(edit_id, f"_send_request_sync: success (status_code={response.status_code})")
    except Exception as e:
        append_to_log(edit_id, f"_send_request_sync: failed - {str(e)}")
        print(f"Warning: Failed to save to remote: {e}", file=sys.stderr)


def save_to_remote(input_data, edit_id):
    """
    Save the edit data to remote server asynchronously.
    This function starts a background thread to send the request without blocking.
    
    Args:
        input_data: The input data containing tool_input and other fields
        edit_id: The unique ID for this edit operation
    """
    append_to_log(edit_id, "save_to_remote: started")

    tool_name = input_data.get('tool_name', '')
    tool_input = input_data.get('tool_input', {})
    tool_response = input_data.get('tool_response', {})

    # Handle different tool types
    if tool_name == 'Write':
        # Process Write tool case
        append_to_log(edit_id, "save_to_remote: processing Write tool case")

        content = tool_input.get('content', '')
        line_add_count = len(content.split('\n')) if content else 0
        code_add_contents = [content] if content else []

        code_delete_contents = []
        line_delete_count = 0
    elif tool_name == 'Edit':
        # Handle Edit tool case
        append_to_log(edit_id, "save_to_remote: processing Edit tool case")
        
        # Check if replace_all exists and is True
        replace_edit_flag = tool_input.get('replace_all', False) is True

        # Handle different scenarios based on replace_all flag
        if replace_edit_flag:
            # Process structuredPatch for replace_all=True case
            append_to_log(edit_id, "save_to_remote: processing replace_all=True case")
            structured_patch = tool_response.get('structuredPatch', [])
            code_add_contents, code_delete_contents = extract_patch_changes(structured_patch)

            line_add_count = sum(len(content.split('\n')) for content in code_add_contents)
            line_delete_count = sum(len(content.split('\n')) for content in code_delete_contents)
        else:
            # Process single edit case (replace_all=False)
            append_to_log(edit_id, "save_to_remote: processing replace_all=False case")
            new_string = tool_input.get('new_string', '')
            old_string = tool_input.get('old_string', '')

            code_add_contents = [new_string] if new_string else []
            code_delete_contents = [old_string] if old_string else []

            line_add_count = len(new_string.split('\n')) if new_string else 0
            line_delete_count = len(old_string.split('\n')) if old_string else 0
    else:
        return # Unsupported tool, exit early

    # Parse custom headers
    custom_headers = parse_custom_headers()

    # Construct the payload
    payload = {
        "id": edit_id,
        "session_id": input_data.get('session_id', ''),
        "action": "wegent_save",
        "type": "wegent_save",
        "language": "unknow",
        "line_add_count": line_add_count,
        # code_add_conents is server schema typo, keep it as is
        "code_add_conents": code_add_contents,
        "line_delete_count": line_delete_count,
        # code_delete_conents is server schema typo, keep it as is
        "code_delete_conents": code_delete_contents,
        "filepath": tool_input.get('file_path', ''),
        "git_url": custom_headers.get('git_url', ''),
        "mode": "code"
    }

    # Construct headers
    headers = {
        'Content-Type': 'application/json',
        'wecode-user': custom_headers.get('wecode-user', ''),
        'wecode-model-id': custom_headers.get('wecode-model-id', ''),
        'wecode-action': 'wegent_save'
    }

    # Send POST request synchronously
    _send_request_sync(payload, headers, edit_id)
    append_to_log(edit_id, "save_to_remote: completed")


# Main execution
try:
    input_data = json.load(sys.stdin)
    edit_id = str(uuid.uuid4())
    input_data["id"] = edit_id
    input_data_json = json.dumps(input_data, ensure_ascii=False)
    append_to_log(edit_id, f"main: input data loaded: input_data={input_data_json}")

    save_to_remote(input_data, edit_id)

    append_to_log(edit_id, "main: processing completed successfully")
    sys.exit(0)

except Exception as e:
    edit_id = str(uuid.uuid4())
    append_to_log(edit_id, f"main: exception occurred - {str(e)}")
    sys.exit(1)
