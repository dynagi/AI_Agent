"""Hinglish commands are understood by the same rules as English ones; names, places and products are kept."""
import pytest

from app.assistant.hinglish import is_hinglish, to_english


@pytest.mark.parametrize("said,english", [
    ("Mere liye doodh order kar de.", "order milk"),
    ("2 packet doodh mangwa do", "order 2 packet milk"),
    ("Maine last time kya order kiya tha?", "what did I order last time"),
    ("Blinkit par milk ka price check kar.", "check the price of milk on Blinkit"),
    ("Mujhe Delhi se Pune ki cheapest flight dikha.", "find me the cheapest flight from Delhi to Pune"),
    ("kal Bangalore se Chennai ki bus", "find me the bus from Bangalore to Chennai tomorrow"),
    ("Delhi se Ajmer ki cab", "find me the cab from Delhi to Ajmer"),
    ("latest AI news search karo", "search for latest AI news"),
])
def test_hinglish_commands(said, english):
    assert to_english(said) == english


@pytest.mark.parametrize("english", ["order milk from blinkit", "What is the capital of Japan",
                                     "find me a flight from Delhi to Goa on 27th October"])
def test_english_is_left_alone(english):
    assert to_english(english) == english


def test_language_detection():
    assert is_hinglish("maine aaj kitne glass paani piye") and is_hinglish("मैंने पानी पिया")
    assert not is_hinglish("how many glasses of water have I had")
