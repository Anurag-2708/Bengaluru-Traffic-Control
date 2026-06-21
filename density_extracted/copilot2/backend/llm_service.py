"""
llm_service.py — LLM integration layer with tool-calling loop.

Sends user queries to an OpenRouter-hosted LLM (default: Gemini 2.5 Flash)
along with tool definitions that map to data_engine / cluster_engine functions.
"""

import json
import logging
import os
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

import data_engine
import cluster_engine

load_dotenv(Path(__file__).resolve().parent / ".env")

logger = logging.getLogger("llm_service")

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL_NAME = os.getenv("MODEL_NAME", "google/gemini-2.5-flash")
MAX_TOOL_ITERATIONS = 4

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = (
    "You are GridGuard, an analytics co-pilot embedded in a traffic incident and event "
    "dashboard used by Bengaluru traffic enforcement officers. "
    "Answer only using the tool results you receive — never invent locations, "
    "counts, or scores. Keep replies to 2-4 short sentences, in plain "
    "operational language. The 'score' is a composite congestion & priority score from 0-100 "
    "combining event frequency, cause diversity, priority levels, and road closure requirement. "
    "If a question can't be answered with the available tools, say so and "
    "suggest an alternative."
)

# ---------------------------------------------------------------------------
# Tool definitions (OpenAI-compatible function-calling schema)
# ---------------------------------------------------------------------------
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_summary",
            "description": "Get a high-level summary of the traffic events dataset including total events, unique vehicles, unique stations, date range, and top event causes and stations.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_violations_by_type",
            "description": "Get the count of events grouped by event cause (e.g. vehicle_breakdown, pot_holes, tree_fall, water_logging), sorted descending. Useful for understanding which event causes are most common.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_violations_by_month",
            "description": "Get the count of events grouped by month (YYYY-MM), sorted chronologically. Useful for identifying trends over time.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_violations_by_station",
            "description": "Get the top N police stations by event count.",
            "parameters": {
                "type": "object",
                "properties": {
                    "n": {
                        "type": "integer",
                        "description": "Number of top stations to return (default 10).",
                    }
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_violations_by_vehicle",
            "description": "Get event counts grouped by vehicle type (heavy_vehicle, bmtc_bus, lcv, private_car, auto, etc.).",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_violations_by_hour",
            "description": "Get event counts grouped by hour of day (0-23). Useful for identifying peak event times.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_violations_by_day_of_week",
            "description": "Get event counts grouped by day of week (Monday through Sunday).",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_top_locations",
            "description": "Get the top N locations (addresses) with the most events.",
            "parameters": {
                "type": "object",
                "properties": {
                    "n": {
                        "type": "integer",
                        "description": "Number of top locations to return (default 10).",
                    }
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_vehicle_type_for_violation",
            "description": "Get the vehicle type distribution for a specific event cause. Use this to understand which vehicles are most commonly involved in a particular incident type.",
            "parameters": {
                "type": "object",
                "properties": {
                    "violation_type": {
                        "type": "string",
                        "description": "The event cause to filter by, e.g. 'vehicle_breakdown', 'pot_holes', 'tree_fall', 'water_logging'.",
                    }
                },
                "required": ["violation_type"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "compare_stations",
            "description": "Compare event statistics between two police stations. Returns totals, top event causes, top vehicle types, and peak hour for each.",
            "parameters": {
                "type": "object",
                "properties": {
                    "station_a": {
                        "type": "string",
                        "description": "Name of the first police station.",
                    },
                    "station_b": {
                        "type": "string",
                        "description": "Name of the second police station.",
                    },
                },
                "required": ["station_a", "station_b"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "compute_hotspots",
            "description": "Compute and return all traffic event hotspot clusters detected via spatial analysis. Each cluster has a composite priority score (0-100), centroid coordinates, dominant cause, vehicle type, and peak hour.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]

# ---------------------------------------------------------------------------
# Mapping from tool names to actual callable functions
# ---------------------------------------------------------------------------
TOOL_IMPL: dict[str, Any] = {
    "get_summary": data_engine.get_summary,
    "get_violations_by_type": data_engine.get_violations_by_type,
    "get_violations_by_month": data_engine.get_violations_by_month,
    "get_violations_by_station": data_engine.get_violations_by_station,
    "get_violations_by_vehicle": data_engine.get_violations_by_vehicle,
    "get_violations_by_hour": data_engine.get_violations_by_hour,
    "get_violations_by_day_of_week": data_engine.get_violations_by_day_of_week,
    "get_top_locations": data_engine.get_top_locations,
    "get_vehicle_type_for_violation": data_engine.get_vehicle_type_for_violation,
    "compare_stations": data_engine.compare_stations,
    "compute_hotspots": cluster_engine.compute_hotspots,
}


def _execute_tool(name: str, arguments: dict) -> Any:
    """Execute a tool function by name with the given arguments."""
    fn = TOOL_IMPL.get(name)
    if fn is None:
        raise ValueError(f"Unknown tool: {name}")
    try:
        return fn(**arguments)
    except Exception as exc:
        logger.exception("Error executing tool %s: %s", name, exc)
        return {"error": str(exc)}


async def chat(user_message: str, history: list | None = None) -> dict:
    """Send a user message to the LLM and run the tool-calling loop."""
    if history is None:
        history = []

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    # Append prior conversation history
    for msg in history:
        messages.append({"role": msg.get("role", "user"), "content": msg.get("content", "")})
    # Append current user message
    messages.append({"role": "user", "content": user_message})

    tool_calls_made: list[str] = []

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:8000",
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        for iteration in range(MAX_TOOL_ITERATIONS):
            payload = {
                "model": MODEL_NAME,
                "messages": messages,
                "tools": TOOLS,
                "tool_choice": "auto",
            }

            logger.info("LLM request iteration %d (model=%s)", iteration + 1, MODEL_NAME)

            try:
                resp = await client.post(OPENROUTER_URL, headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()
            except httpx.HTTPStatusError as exc:
                logger.error("OpenRouter HTTP error: %s — %s", exc.response.status_code, exc.response.text)
                return {
                    "response": f"Sorry, the AI service returned an error (HTTP {exc.response.status_code}). Please try again.",
                    "tool_calls_made": tool_calls_made,
                }
            except httpx.RequestError as exc:
                logger.error("OpenRouter request error: %s", exc)
                return {
                    "response": "Sorry, I couldn't reach the AI service. Please check your network and API key.",
                    "tool_calls_made": tool_calls_made,
                }

            choice = data.get("choices", [{}])[0]
            message = choice.get("message", {})

            # If the model did NOT request tool calls, return its text response
            tool_calls = message.get("tool_calls")
            if not tool_calls:
                return {
                    "response": message.get("content", "I wasn't able to generate a response."),
                    "tool_calls_made": tool_calls_made,
                }

            # Model requested tool calls — execute each one
            messages.append(message)

            for tc in tool_calls:
                fn_name = tc["function"]["name"]
                try:
                    fn_args = json.loads(tc["function"].get("arguments", "{}"))
                except json.JSONDecodeError:
                    fn_args = {}

                logger.info("Executing tool: %s(%s)", fn_name, fn_args)
                tool_calls_made.append(fn_name)

                result = _execute_tool(fn_name, fn_args)

                # Truncate very large results to stay within context limits
                result_str = json.dumps(result, default=str)
                if len(result_str) > 12000:
                    if isinstance(result, list) and len(result) > 20:
                        result = result[:20]
                        result_str = json.dumps(result, default=str)
                        result_str += f"\n... (truncated, showing 20 of {len(result)} items)"

                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": result_str,
                })

    return {
        "response": "I processed your request but ran out of reasoning steps. Please try a simpler question.",
        "tool_calls_made": tool_calls_made,
    }
