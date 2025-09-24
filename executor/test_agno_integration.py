#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Test script for Agno agent integration
"""

import asyncio
import json
import os
from typing import Dict, Any

from executor.agents.factory import AgentFactory
from shared.status import TaskStatus


def create_test_task_data() -> Dict[str, Any]:
    """
    Create test task data for Agno agent
    """
    return {
        "task_id": 1,
        "subtask_id": 1,
        "task_title": "Test Agno Agent",
        "subtask_title": "Test Agno Integration",
        "prompt": "Hello, please introduce yourself and tell me what you can do.",
        "bot": {
            "agent_name": "agno",
            "model": "claude",
            "model_id": "claude-3-5-sonnet-20241022",
            "system_prompt": "You are a helpful assistant.",
            "team_name": "TestTeam",
            "team_description": "Test team for Agno agent integration",
            "team_members": [
                {
                    "name": "TestAgent",
                    "description": "Test agent for integration testing"
                }
            ]
        }
    }


def test_agno_agent_creation():
    """
    Test Agno agent creation
    """
    print("Testing Agno agent creation...")
    
    task_data = create_test_task_data()
    
    try:
        # Create agent using factory
        agent = AgentFactory.get_agent("agno", task_data)
        
        if agent is None:
            print("❌ Failed to create Agno agent")
            return False
        
        print(f"✅ Agno agent created successfully: {agent.get_name()}")
        
        # Test agent initialization
        init_status = agent.initialize()
        if init_status != TaskStatus.SUCCESS:
            print(f"❌ Agent initialization failed: {init_status}")
            return False
        
        print("✅ Agent initialization successful")
        return True
        
    except Exception as e:
        print(f"❌ Error creating Agno agent: {str(e)}")
        return False


def test_agno_agent_execution():
    """
    Test Agno agent execution (synchronous)
    """
    print("\nTesting Agno agent execution (synchronous)...")
    
    task_data = create_test_task_data()
    
    try:
        # Create agent
        agent = AgentFactory.get_agent("agno", task_data)
        
        if agent is None:
            print("❌ Failed to create Agno agent")
            return False
        
        # Initialize agent
        init_status = agent.initialize()
        if init_status != TaskStatus.SUCCESS:
            print(f"❌ Agent initialization failed: {init_status}")
            return False
        
        # Execute agent
        result_status, error_msg = agent.handle()
        
        if result_status == TaskStatus.FAILED:
            print(f"❌ Agent execution failed: {error_msg}")
            return False
        elif result_status == TaskStatus.RUNNING:
            print("✅ Agent execution started (async mode)")
            return True
        else:
            print(f"✅ Agent execution completed with status: {result_status}")
            return True
            
    except Exception as e:
        print(f"❌ Error executing Agno agent: {str(e)}")
        return False


async def test_agno_agent_execution_async():
    """
    Test Agno agent execution (asynchronous)
    """
    print("\nTesting Agno agent execution (asynchronous)...")
    
    task_data = create_test_task_data()
    
    try:
        # Create agent
        agent = AgentFactory.get_agent("agno", task_data)
        
        if agent is None:
            print("❌ Failed to create Agno agent")
            return False
        
        # Initialize agent
        init_status = agent.initialize()
        if init_status != TaskStatus.SUCCESS:
            print(f"❌ Agent initialization failed: {init_status}")
            return False
        
        # Execute agent asynchronously
        result_status = await agent.execute_async()
        
        if result_status == TaskStatus.FAILED:
            print(f"❌ Agent async execution failed")
            return False
        else:
            print(f"✅ Agent async execution completed with status: {result_status}")
            return True
            
    except Exception as e:
        print(f"❌ Error executing Agno agent asynchronously: {str(e)}")
        return False


def main():
    """
    Main test function
    """
    print("🚀 Starting Agno agent integration tests...")
    print("=" * 50)
    
    # Test 1: Agent creation
    test1_passed = test_agno_agent_creation()
    
    # Test 2: Agent execution (synchronous)
    test2_passed = test_agno_agent_execution()
    
    # Test 3: Agent execution (asynchronous)
    test3_passed = asyncio.run(test_agno_agent_execution_async())
    
    print("\n" + "=" * 50)
    print("📊 TEST RESULTS:")
    print("=" * 50)
    
    print(f"Agent Creation Test: {'✅ PASSED' if test1_passed else '❌ FAILED'}")
    print(f"Agent Execution Test (Sync): {'✅ PASSED' if test2_passed else '❌ FAILED'}")
    print(f"Agent Execution Test (Async): {'✅ PASSED' if test3_passed else '❌ FAILED'}")
    
    if all([test1_passed, test2_passed, test3_passed]):
        print("\n🎉 All tests passed! Agno agent integration is working correctly.")
        return True
    else:
        print("\n❌ Some tests failed. Please check the implementation.")
        return False


if __name__ == "__main__":
    success = main()
    exit(0 if success else 1)