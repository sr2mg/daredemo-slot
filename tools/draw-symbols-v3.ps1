Add-Type -AssemblyName System.Drawing

$W = 1536
$H = 1024
$Bg = [System.Drawing.Color]::FromArgb(217, 217, 217)

function New-Canvas {
    $bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear($Bg)
    return @($bmp, $g)
}

function New-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function Draw-StickerPath($g, $path, $brush, [float]$whiteWidth = 58, [float]$blackWidth = 26) {
    $whitePen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $whiteWidth)
    $whitePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $blackPen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, $blackWidth)
    $blackPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPath($whitePen, $path)
    $g.DrawPath($blackPen, $path)
    $g.FillPath($brush, $path)
    $whitePen.Dispose()
    $blackPen.Dispose()
}

function Draw-StickerStroke($g, $path, $color, [float]$innerWidth, [float]$whiteWidth, [float]$blackWidth) {
    $whitePen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $whiteWidth)
    $whitePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $whitePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $whitePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $blackPen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, $blackWidth)
    $blackPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $blackPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $blackPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $fillPen = New-Object System.Drawing.Pen($color, $innerWidth)
    $fillPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $fillPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $fillPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPath($whitePen, $path)
    $g.DrawPath($blackPen, $path)
    $g.DrawPath($fillPen, $path)
    $whitePen.Dispose()
    $blackPen.Dispose()
    $fillPen.Dispose()
}

function Save-Canvas($bmp, $g, [string]$name) {
    $g.Dispose()
    $path = Join-Path (Get-Location) $name
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

function New-LinearBrush($x, $y, $w, $h, $c1, $c2, $mode = [System.Drawing.Drawing2D.LinearGradientMode]::Vertical) {
    $rect = New-Object System.Drawing.RectangleF($x, $y, $w, $h)
    return New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, $mode)
}

function Add-Highlight($g, [float]$x, [float]$y, [float]$w, [float]$h, [int]$alpha = 150) {
    $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($alpha, 255, 255, 255))
    $g.FillEllipse($b, $x, $y, $w, $h)
    $b.Dispose()
}

function Draw-Star($g, [float]$cx, [float]$cy, [float]$r1, [float]$r2) {
    $pts = New-Object 'System.Drawing.PointF[]' 8
    for ($i = 0; $i -lt 8; $i++) {
        $ang = (-90 + $i * 45) * [Math]::PI / 180
        $r = $(if ($i % 2 -eq 0) { $r1 } else { $r2 })
        $pts[$i] = New-Object System.Drawing.PointF(($cx + [Math]::Cos($ang) * $r), ($cy + [Math]::Sin($ang) * $r))
    }
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddPolygon($pts)
    $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    Draw-StickerPath $g $p $b 18 8
    $p.Dispose()
    $b.Dispose()
}

# 1. Seven
$pair = New-Canvas; $bmp = $pair[0]; $g = $pair[1]
$seven = New-Object System.Drawing.Drawing2D.GraphicsPath
$seven.AddPolygon([System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(158, 230),
    [System.Drawing.PointF]::new(1380, 230),
    [System.Drawing.PointF]::new(1380, 370),
    [System.Drawing.PointF]::new(800, 820),
    [System.Drawing.PointF]::new(540, 820),
    [System.Drawing.PointF]::new(1116, 378),
    [System.Drawing.PointF]::new(158, 378)
))
$redBrush = New-LinearBrush 150 210 1240 640 ([System.Drawing.Color]::FromArgb(255, 235, 45, 38)) ([System.Drawing.Color]::FromArgb(255, 120, 0, 25))
Draw-StickerPath $g $seven $redBrush 70 30
$shine = New-Object System.Drawing.Drawing2D.GraphicsPath
$shine.AddPolygon([System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(240, 260),
    [System.Drawing.PointF]::new(1240, 260),
    [System.Drawing.PointF]::new(1190, 305),
    [System.Drawing.PointF]::new(230, 305)
))
$shineBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(120, 255, 205, 190))
$g.FillPath($shineBrush, $shine)
Draw-Star $g 1265 214 48 14
$redBrush.Dispose(); $shine.Dispose(); $shineBrush.Dispose(); $seven.Dispose()
Save-Canvas $bmp $g "v3_seven.png"

# 2. BAR
$pair = New-Canvas; $bmp = $pair[0]; $g = $pair[1]
$outer = New-RoundedRectPath 130 300 1276 390 105
$gold = New-LinearBrush 130 300 1276 390 ([System.Drawing.Color]::FromArgb(255, 255, 217, 68)) ([System.Drawing.Color]::FromArgb(255, 168, 92, 8))
Draw-StickerPath $g $outer $gold 58 24
$inner = New-RoundedRectPath 215 370 1106 250 66
$blackBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 22, 22, 26))
$g.FillPath($blackBrush, $inner)
$edgePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 255, 244, 165), 22)
$edgePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$g.DrawPath($edgePen, $outer)
$fontFam = New-Object System.Drawing.FontFamily("Arial Black")
$textPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$textPath.AddString("BAR", $fontFam, [int][System.Drawing.FontStyle]::Bold, 205, [System.Drawing.RectangleF]::new(214, 346, 1110, 290), $fmt)
$textOutline = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 12)
$textOutline.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$g.DrawPath($textOutline, $textPath)
$g.FillPath($whiteBrush, $textPath)
Add-Highlight $g 250 322 760 56 95
$outer.Dispose(); $inner.Dispose(); $gold.Dispose(); $blackBrush.Dispose(); $edgePen.Dispose(); $fontFam.Dispose(); $textPath.Dispose(); $fmt.Dispose(); $textOutline.Dispose(); $whiteBrush.Dispose()
Save-Canvas $bmp $g "v3_bar.png"

# 3. Bell
$pair = New-Canvas; $bmp = $pair[0]; $g = $pair[1]
$ribbon = New-Object System.Drawing.Drawing2D.GraphicsPath
$ribbon.AddPolygon([System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(610, 245),
    [System.Drawing.PointF]::new(760, 310),
    [System.Drawing.PointF]::new(610, 380),
    [System.Drawing.PointF]::new(575, 315)
))
$ribbon.AddPolygon([System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(925, 245),
    [System.Drawing.PointF]::new(780, 310),
    [System.Drawing.PointF]::new(925, 380),
    [System.Drawing.PointF]::new(960, 315)
))
$red = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 224, 30, 42))
Draw-StickerPath $g $ribbon $red 42 18
$bell = New-Object System.Drawing.Drawing2D.GraphicsPath
$bell.StartFigure()
$bell.AddBezier(520, 300, 410, 415, 365, 620, 270, 720)
$bell.AddBezier(270, 720, 540, 805, 995, 805, 1266, 720)
$bell.AddBezier(1266, 720, 1168, 620, 1122, 410, 1015, 300)
$bell.AddBezier(1015, 300, 880, 230, 655, 230, 520, 300)
$bell.CloseFigure()
$bellBrush = New-LinearBrush 260 240 1010 560 ([System.Drawing.Color]::FromArgb(255, 255, 226, 78)) ([System.Drawing.Color]::FromArgb(255, 205, 126, 14))
Draw-StickerPath $g $bell $bellBrush 62 28
$mouthPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(210, 127, 69, 0), 28)
$mouthPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$mouthPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawBezier($mouthPen, 345, 700, 590, 760, 950, 760, 1190, 700)
Add-Highlight $g 560 340 250 82 135
$frontRibbon = New-Object System.Drawing.Drawing2D.GraphicsPath
$frontRibbon.AddPolygon([System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(640, 255),
    [System.Drawing.PointF]::new(760, 312),
    [System.Drawing.PointF]::new(642, 372),
    [System.Drawing.PointF]::new(600, 312)
))
$frontRibbon.AddPolygon([System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(895, 255),
    [System.Drawing.PointF]::new(775, 312),
    [System.Drawing.PointF]::new(895, 372),
    [System.Drawing.PointF]::new(935, 312)
))
$frontRibbon.AddEllipse(720, 272, 95, 82)
Draw-StickerPath $g $frontRibbon $red 36 16
$clapper = New-Object System.Drawing.Drawing2D.GraphicsPath
$clapper.AddEllipse(695, 710, 150, 110)
Draw-StickerPath $g $clapper $red 34 14
$ribbon.Dispose(); $frontRibbon.Dispose(); $red.Dispose(); $bell.Dispose(); $bellBrush.Dispose(); $mouthPen.Dispose(); $clapper.Dispose()
Save-Canvas $bmp $g "v3_bell.png"

# 4. Replay
$pair = New-Canvas; $bmp = $pair[0]; $g = $pair[1]
$badge = New-RoundedRectPath 210 302 1116 388 190
$badgeBrush = New-LinearBrush 210 302 1116 388 ([System.Drawing.Color]::FromArgb(255, 38, 162, 247)) ([System.Drawing.Color]::FromArgb(255, 0, 67, 174))
Draw-StickerPath $g $badge $badgeBrush 58 24
$topArc = New-Object System.Drawing.Drawing2D.GraphicsPath
$topArc.AddArc(405, 375, 730, 270, 188, 172)
$botArc = New-Object System.Drawing.Drawing2D.GraphicsPath
$botArc.AddArc(405, 375, 730, 270, 8, 172)
Draw-StickerStroke $g $topArc ([System.Drawing.Color]::FromArgb(255, 0, 83, 215)) 62 112 82
Draw-StickerStroke $g $botArc ([System.Drawing.Color]::FromArgb(255, 0, 138, 255)) 62 112 82
foreach ($poly in @(
    @([System.Drawing.PointF]::new(1090,410),[System.Drawing.PointF]::new(1215,476),[System.Drawing.PointF]::new(1084,548)),
    @([System.Drawing.PointF]::new(446,616),[System.Drawing.PointF]::new(318,550),[System.Drawing.PointF]::new(450,478))
)) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddPolygon([System.Drawing.PointF[]]$poly)
    $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0, 105, 235))
    Draw-StickerPath $g $p $b 46 20
    $p.Dispose(); $b.Dispose()
}
Add-Highlight $g 360 335 630 52 90
$badge.Dispose(); $badgeBrush.Dispose(); $topArc.Dispose(); $botArc.Dispose()
Save-Canvas $bmp $g "v3_replay.png"

# 5. Cherry
$pair = New-Canvas; $bmp = $pair[0]; $g = $pair[1]
$stemPen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 70)
$stemPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round; $stemPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawBezier($stemPen, 640, 405, 640, 300, 720, 282, 768, 255)
$g.DrawBezier($stemPen, 890, 405, 872, 300, 810, 280, 768, 255)
$stemBlack = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 36)
$stemBlack.StartCap = [System.Drawing.Drawing2D.LineCap]::Round; $stemBlack.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawBezier($stemBlack, 640, 405, 640, 300, 720, 282, 768, 255)
$g.DrawBezier($stemBlack, 890, 405, 872, 300, 810, 280, 768, 255)
$stemFill = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 95, 80, 34), 18)
$stemFill.StartCap = [System.Drawing.Drawing2D.LineCap]::Round; $stemFill.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawBezier($stemFill, 640, 405, 640, 300, 720, 282, 768, 255)
$g.DrawBezier($stemFill, 890, 405, 872, 300, 810, 280, 768, 255)
$leaf = New-Object System.Drawing.Drawing2D.GraphicsPath
$leaf.AddBezier(785, 255, 900, 175, 1010, 212, 1045, 292)
$leaf.AddBezier(1045, 292, 925, 335, 835, 318, 785, 255)
$leaf.CloseFigure()
$leafBrush = New-LinearBrush 780 180 270 160 ([System.Drawing.Color]::FromArgb(255, 111, 215, 70)) ([System.Drawing.Color]::FromArgb(255, 30, 130, 44))
Draw-StickerPath $g $leaf $leafBrush 42 18
foreach ($ellipse in @(@(415, 405, 390, 330), @(725, 405, 390, 330))) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddEllipse($ellipse[0], $ellipse[1], $ellipse[2], $ellipse[3])
    $rb = New-LinearBrush $ellipse[0] $ellipse[1] $ellipse[2] $ellipse[3] ([System.Drawing.Color]::FromArgb(255, 255, 54, 56)) ([System.Drawing.Color]::FromArgb(255, 145, 0, 27))
    Draw-StickerPath $g $p $rb 58 24
    Add-Highlight $g ($ellipse[0] + 92) ($ellipse[1] + 72) 102 60 150
    $p.Dispose(); $rb.Dispose()
}
$stemPen.Dispose(); $stemBlack.Dispose(); $stemFill.Dispose(); $leaf.Dispose(); $leafBrush.Dispose()
Save-Canvas $bmp $g "v3_cherry.png"

# 6. Melon
$pair = New-Canvas; $bmp = $pair[0]; $g = $pair[1]
$slice = New-Object System.Drawing.Drawing2D.GraphicsPath
$slice.StartFigure()
$slice.AddBezier(190, 660, 395, 345, 1140, 345, 1348, 660)
$slice.AddLine(1348, 660, 190, 660)
$slice.CloseFigure()
$redFlesh = New-LinearBrush 190 330 1158 350 ([System.Drawing.Color]::FromArgb(255, 255, 82, 87)) ([System.Drawing.Color]::FromArgb(255, 214, 20, 42))
Draw-StickerPath $g $slice $redFlesh 58 24
$rindOuter = New-Object System.Drawing.Drawing2D.GraphicsPath
$rindOuter.AddBezier(190, 660, 430, 762, 1110, 762, 1348, 660)
$rindOuter.AddLine(1348, 660, 190, 660)
$rindOuter.CloseFigure()
$rindBrush = New-LinearBrush 190 640 1158 120 ([System.Drawing.Color]::FromArgb(255, 50, 176, 78)) ([System.Drawing.Color]::FromArgb(255, 0, 96, 49))
$g.FillPath($rindBrush, $rindOuter)
$stripePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 168, 236, 90), 18)
for ($x = 310; $x -le 1200; $x += 145) {
    $g.DrawLine($stripePen, $x, 675, $x + 58, 728)
}
foreach ($seed in @(@(530,520), @(680,585), @(795,505), @(930,580), @(1065,522))) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddEllipse($seed[0], $seed[1], 38, 70)
    $m = New-Object System.Drawing.Drawing2D.Matrix
    $m.RotateAt(-18, [System.Drawing.PointF]::new($seed[0] + 19, $seed[1] + 35))
    $p.Transform($m)
    $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 24, 20, 22))
    $g.FillPath($b, $p)
    $p.Dispose(); $m.Dispose(); $b.Dispose()
}
Add-Highlight $g 415 424 485 46 90
$slice.Dispose(); $redFlesh.Dispose(); $rindOuter.Dispose(); $rindBrush.Dispose(); $stripePen.Dispose()
Save-Canvas $bmp $g "v3_melon.png"

# 7. Broccoli blank
$pair = New-Canvas; $bmp = $pair[0]; $g = $pair[1]
$stem = New-Object System.Drawing.Drawing2D.GraphicsPath
$stem.AddBezier(680, 550, 625, 690, 615, 770, 540, 825)
$stem.AddLine(540, 825, 995, 825)
$stem.AddBezier(995, 825, 920, 770, 910, 690, 856, 550)
$stem.CloseFigure()
$stemBrush = New-LinearBrush 540 545 455 280 ([System.Drawing.Color]::FromArgb(255, 122, 208, 85)) ([System.Drawing.Color]::FromArgb(255, 44, 130, 59))
Draw-StickerPath $g $stem $stemBrush 50 22
$floretBrush = New-LinearBrush 260 225 1010 420 ([System.Drawing.Color]::FromArgb(255, 90, 218, 86)) ([System.Drawing.Color]::FromArgb(255, 16, 132, 70))
$florets = @(
    @(285, 420, 250, 220), @(415, 320, 270, 260), @(610, 260, 290, 285),
    @(840, 320, 285, 260), @(1040, 425, 235, 215), @(500, 470, 260, 220),
    @(760, 465, 285, 230)
)
foreach ($e in $florets) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddEllipse($e[0], $e[1], $e[2], $e[3])
    Draw-StickerPath $g $p $floretBrush 48 20
    Add-Highlight $g ($e[0] + 55) ($e[1] + 45) 95 45 70
    $p.Dispose()
}
$facePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 20, 70, 38), 12)
$eyeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 20, 70, 38))
$g.FillEllipse($eyeBrush, 705, 705, 22, 28)
$g.FillEllipse($eyeBrush, 810, 705, 22, 28)
$g.DrawArc($facePen, 725, 720, 95, 62, 18, 144)
$stem.Dispose(); $stemBrush.Dispose(); $floretBrush.Dispose(); $facePen.Dispose(); $eyeBrush.Dispose()
Save-Canvas $bmp $g "v3_blank.png"
