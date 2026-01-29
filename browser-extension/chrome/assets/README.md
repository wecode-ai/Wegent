# Icon Files

The extension requires PNG icons in the following sizes:
- icon-16.png (16x16)
- icon-32.png (32x32)
- icon-48.png (48x48)
- icon-128.png (128x128)

## Generating Icons

You can generate the icons from the `icon.svg` file using ImageMagick or a similar tool:

```bash
# Using ImageMagick
convert icon.svg -resize 16x16 icon-16.png
convert icon.svg -resize 32x32 icon-32.png
convert icon.svg -resize 48x48 icon-48.png
convert icon.svg -resize 128x128 icon-128.png
```

Or use an online tool like https://realfavicongenerator.net/

## Design

The icon uses Wegent's primary teal color (#14B8A6) with a globe/network symbol representing the AI-native operating system for intelligent agent teams.
