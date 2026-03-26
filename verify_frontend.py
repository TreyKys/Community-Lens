from playwright.sync_api import sync_playwright, expect
import os
import glob

def verify(page):
    page.on("console", lambda msg: print(f"Browser console: {msg.text}"))
    page.on("pageerror", lambda msg: print(f"Browser error: {msg}"))

    # Navigate back to Desktop
    page.set_viewport_size({"width": 1280, "height": 800})
    page.wait_for_timeout(1000)

    # Go to an Event Page
    page.goto("http://localhost:3000/event/1", timeout=60000)
    page.wait_for_timeout(5000) # Wait a bit longer for recharts to load

    page.screenshot(path="/home/jules/verification/event_page.png")
    page.wait_for_timeout(1000)

if __name__ == "__main__":
    os.makedirs("/home/jules/verification/video", exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(record_video_dir="/home/jules/verification/video")
        page = context.new_page()
        try:
            verify(page)
        except Exception as e:
            print(f"Error: {e}")
        finally:
            context.close()
            browser.close()

        videos = glob.glob("/home/jules/verification/video/*.webm")
        if videos:
            print(f"Video saved to: {videos[0]}")
