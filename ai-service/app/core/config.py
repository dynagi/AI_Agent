from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_SERVICE_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    # Repo-root .env first, then an optional ai-service/.env that overrides it.
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore")

    environment: str = "development"
    port: int = 8000

    llm_provider: str = "nvidia"  # "nvidia" | "grok" | "openrouter"

    grok_api_key: str = ""
    grok_base_url: str = "https://api.x.ai/v1"
    grok_model: str = "grok-2-latest"

    nvidia_api_key: str = ""
    nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"
    nvidia_model: str = "openai/gpt-oss-20b"
    # Tried in order when the main model fails. Hosted models are retired or overloaded without notice
    # (nemotron-3-super was switched off on 2026-10-03), so one model must never be a single point of failure.
    llm_fallback_models: str = "openai/gpt-oss-20b,nvidia/nemotron-3-ultra-550b-a55b,nvidia/nemotron-3.5-lightning-30b-a3b"

    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    # Fast and reliable for short spoken replies (~3 s). Any OpenRouter model id works.
    openrouter_model: str = "anthropic/claude-haiku-4.5"
    # Reply-length cap used when a caller doesn't set one. Without it a request reserves the model's full output
    # limit (64k tokens on Claude), which pay-per-token providers refuse when the account's credit is low.
    llm_default_max_tokens: int = 1500

    voice_provider: str = "gemini"  # "gemini" | "elevenlabs"

    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = "21m00Tcm4TlvDq8ikWAM"

    gemini_api_key: str = ""
    gemini_tts_model: str = "gemini-2.5-flash-preview-tts"
    gemini_voice_name: str = "Kore"

    supabase_url: str = ""
    supabase_service_role_key: str = ""

    # Used for both Shopping (Google Shopping engine) and Travel
    # (Google Flights / Google Hotels engines) — Amadeus's self-service
    # portal was decommissioned, so SerpAPI covers travel too now.
    serpapi_api_key: str = ""

    # Hosts without a permanent disk (Render free): keep app/data (learned models) in a private Supabase bucket.
    # "supabase" turns it on; empty = files stay on the local disk only. See app/services/data_sync.py.
    data_sync: str = ""
    data_sync_bucket: str = "aura-ai-data"
    # Locale for shopping/flight/hotel results (Google country code + ISO currency).
    default_country: str = "in"
    default_currency: str = "INR"

    # Travel next-trip model (trained in synthetic_data/train_improved.py) and the demo users
    # it can be tried on before real AURA users have any travel history.
    travel_model_dir: str = str(_SERVICE_ROOT / "models" / "travel")
    travel_demo_events: str = str(_SERVICE_ROOT / "data" / "demo_travel_events.csv")
    travel_demo_enabled: bool = True

    # Shopping next-purchase model (base trained in synthetic_data/train_shopping.py). Every shopping
    # agent command logs events and schedules a fine-tune on real users' history; the fine-tuned model
    # is written to shopping_model_runtime_dir (not committed) and hot-swapped in.
    shopping_model_dir: str = str(_SERVICE_ROOT / "models" / "shopping")
    shopping_model_runtime_dir: str = str(_SERVICE_ROOT / "app" / "data" / "shopping")
    shopping_demo_events: str = str(_SERVICE_ROOT / "data" / "demo_shopping_events.csv")
    shopping_demo_enabled: bool = True
    # wait this long after the last command before retraining, so a burst of commands trains once
    shopping_retrain_debounce_s: float = 20.0
    # and never retrain more often than this
    shopping_retrain_min_interval_s: float = 120.0
    # The cart agent asks the LLM only for screens its fast path can't handle. It tries this quicker model
    # first (with a short timeout), then the main model (nvidia_model / grok_model). Empty = main model only.
    shopping_agent_model: str = "openai/gpt-oss-20b"

    @property
    def cart_agent_model(self) -> str | None:
        """The quicker model for cart-agent steps. It is an NVIDIA model id, so it only applies when NVIDIA is the
        provider; with Grok/OpenRouter the provider's own model is used (None)."""
        return (self.shopping_agent_model or None) if self.llm_provider == "nvidia" else None
    shopping_agent_timeout_s: float = 25.0

    # Screen agent (the phone reads the screen and acts on spoken commands) and visual product search.
    # Screens that need a look at the pixels are sent to a vision-capable model. Set VISION_MODEL to an id that exists
    # on the active provider (NVIDIA / Grok / OpenRouter ids differ). Left empty, a sensible default per provider is
    # used (see vision_model_id); hosted models get retired, so set it in .env if the default is gone.
    vision_model: str = ""
    screen_agent_timeout_s: float = 40.0

    @property
    def vision_model_id(self) -> str | None:
        """The model for screenshots, or None to use the provider's main model (OpenRouter's Claude models accept images)."""
        if self.vision_model:
            return self.vision_model
        return {"nvidia": "meta/llama-3.2-90b-vision-instruct", "grok": "grok-2-vision-latest"}.get(self.llm_provider)


settings = Settings()
