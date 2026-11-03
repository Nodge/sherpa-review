# README media

These captures show Sherpa 0.11.1 at commit `ecbe204`, in Chromium, using the `medium` fixture PR. The route, review comment and agent note are prepared demo data. No live repository, GitHub credentials or model service is involved.

| File | Content |
|---|---|
| `review-demo.gif` | Overview fills with the summary and route stops. The reviewer opens the route, scrolls from stop 01 to stop 02, comments on lines 6–9 in `edit-policy.ts` and clicks "Request changes". Dark theme, 1600 × 1000, about 30 seconds at 15 fps |
| `review-demo.mp4` | The same sequence at 2560 × 1600 and 30 fps, encoded as H.264 with CRF 16 and fast start |
| `review-demo.png` | The saved comment before "Request changes", at 2560 × 1600 |
| `test-digest.png` | Route stop 04, captured as an element so the whole test digest fits. Dark theme |
| `full-diff-dark.png` | The same file and agent note in the full diff. Dark theme, 1280 × 800 |

To refresh the media, start the fixture server with a separate `--sherpa-dir` in a temporary directory. Build the route through the CLI using the prepared results in `packages/fixtures/src/data/route-medium*.ts`. Use English and the default text size. Capture the real UI without changing its markup or styles. For the video, use a 1280 × 800 viewport at device scale factor 2. Keep the initial Overview, the summary and each route stop arriving, and the click on "Open the route". Record the scroll from stop 01 to stop 02 as one continuous movement. Select lines 6–9, write a comment, save the draft and click "Request changes". Speed up generation and cut pauses between actions. Leave the "Changes requested" screen visible for several seconds.

The GIF uses a 256-colour palette without dithering to keep text and flat backgrounds clear. Convert a new recording with:

```sh
ffmpeg -i review-demo.mp4 -filter_complex '[0:v]fps=15,scale=1600:1000:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle' -loop 0 review-demo.gif
```
