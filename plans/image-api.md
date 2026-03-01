`POST https://ark.cn-beijing.volces.com/api/v3/images/generations` [运行](https://api.volcengine.com/api-explorer/?action=ImageGenerations&groupName=%E5%9B%BE%E7%89%87%E7%94%9F%E6%88%90API&serviceCode=ark&version=2024-01-01&tab=2#N4IgTgpgzgDg9gOyhA+gMzmAtgQwC4gBcIArmADYgA0IUAlgF4REgBMA0tSAO74TY4wAayJoc5ZDSxwAJhErEZcEgCMccALTIIMyDiwaALBoAMG1gFYTADlbWuMMHCwwCxQPhmgUTTA-l6Ao2MAw-4CLeYB4tkHBgDOJgE2KgF+KgABygGHxgNf6gPSmgN2egCwegHEegCFugLCagCfKgOhKgGbx-oBFRoBjkYCTkZGA34qA2Ur+gKyugI76gOSagOJO-oDU5oCnpoBHphWA+Ib+gBVKI4Cf2oAr1oBOQf5wAMaATHaAy+b+gJKKgP1+gL-xgFRxY4CABoCEVoBTPv6A9maAj7b+gKGxgA3OgHnagNxygJJy-peAuyH+gNyugEbpgFgJgHH4wBjfoBvQOygAY5QAz2tkZoBLfUAQjqAQmtAIoagAIEp6AZXlAHBygC51c7+QAUsUNAPjuD38gHSzQKAOYzADMB52y6xagAlTQA55oBSELR0UA2DaAF7V-IAXU0xgB9FQDuioAvIMA9OaAbz1AM8GI0AHJqAAn1soB-PUAS5GAeASKmz-IAAAPW-kAs8qAEB1-IBA80AL4GMlr+QBc+oBUfUagDwVQA2aiAAL5AA)
本文介绍图片生成模型如 Seedream 5.0 lite 的调用 API ，包括输入输出参数，取值范围，注意事项等信息，供您使用接口时查阅字段含义。

**不同模型支持的图片生成能力简介**

* **doubao\-seedream\-5.0\-lite==^new^==** **、doubao\-seedream\-4.5/4.0**
   * 生成组图（组图：基于您输入的内容，生成的一组内容关联的图片；需配置 **sequential_image_generation ** 为`auto` **）** 
      * 多图生组图，根据您输入的 **++多张参考图片（2\-14）++ **  +++文本提示词++ 生成一组内容关联的图片（输入的参考图数量+最终生成的图片数量≤15张）。
      * 单图生组图，根据您输入的 ++单张参考图片+文本提示词++ 生成一组内容关联的图片（最多生成14张图片）。
      * 文生组图，根据您输入的 ++文本提示词++ 生成一组内容关联的图片（最多生成15张图片）。
   * 生成单图（配置 **sequential_image_generation ** 为`disabled` **）** 
      * 多图生图，根据您输入的 **++多张参考图片（2\-14）++ **  +++文本提示词++ 生成单张图片。
      * 单图生图，根据您输入的 ++单张参考图片+文本提示词++ 生成单张图片。
      * 文生图，根据您输入的 ++文本提示词++ 生成单张图片。
* **doubao\-seedream\-3.0\-t2i**
   * 文生图，根据您输入的 ++文本提示词++ 生成单张图片。
* **doubao\-seededit\-** **3.0** **\-i2i**
   * 图生图，根据您输入的 ++单张参考图片+文本提示词++ 生成单张图片。

&nbsp;

```mixin-react
return (<Tabs>
<Tabs.TabPane title="鉴权说明" key="oOTdY3Sn"><RenderMd content={`本接口仅支持 API Key 鉴权，请在 [获取 API Key](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey) 页面，获取长效 API Key。
`}></RenderMd></Tabs.TabPane>
<Tabs.TabPane title="快速入门" key="HHCpvO5jKo"><RenderMd content={` [ ](#)[体验中心](https://console.volcengine.com/ark/region:ark+cn-beijing/experience/vision?type=GenImage)       <span>![图片](https://portal.volccdn.com/obj/volcfe/cloud-universal-doc/upload_2abecd05ca2779567c6d32f0ddc7874d.png =20x) </span>[模型列表](https://www.volcengine.com/docs/82379/1330310?lang=zh#d3e5e0eb)       <span>![图片](https://portal.volccdn.com/obj/volcfe/cloud-universal-doc/upload_a5fdd3028d35cc512a10bd71b982b6eb.png =20x) </span>[模型计费](https://www.volcengine.com/docs/82379/1544106?lang=zh#457edfd0)       <span>![图片](https://portal.volccdn.com/obj/volcfe/cloud-universal-doc/upload_afbcf38bdec05c05089d5de5c3fd8fc8.png =20x) </span>[API Key](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey?apikey=%7B%7D)
 <span>![图片](https://portal.volccdn.com/obj/volcfe/cloud-universal-doc/upload_57d0bca8e0d122ab1191b40101b5df75.png =20x) </span>[调用教程](https://www.volcengine.com/docs/82379/1548482)       <span>![图片](https://portal.volccdn.com/obj/volcfe/cloud-universal-doc/upload_f45b5cd5863d1eed3bc3c81b9af54407.png =20x) </span>[接口文档](https://www.volcengine.com/docs/82379/1666945)       <span>![图片](https://portal.volccdn.com/obj/volcfe/cloud-universal-doc/upload_1609c71a747f84df24be1e6421ce58f0.png =20x) </span>[常见问题](https://www.volcengine.com/docs/82379/1359411)       <span>![图片](https://portal.volccdn.com/obj/volcfe/cloud-universal-doc/upload_bef4bc3de3535ee19d0c5d6c37b0ffdd.png =20x) </span>[开通模型](https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&OpenTokenDrawer=false)
`}></RenderMd></Tabs.TabPane></Tabs>);
```


---


<span id="7thx2dVa"></span>
## 请求参数 
<span id="BFVUvDi6"></span>
### 请求体

---


**model** `string` %%require%%
本次请求使用模型的 [Model ID](https://www.volcengine.com/docs/82379/1099455?lang=zh#fc299dc6) 或[推理接入点](https://www.volcengine.com/docs/82379/1099522) (Endpoint ID)。

---


**prompt ** `string` %%require%%
用于生成图像的提示词，支持中英文。（查看提示词指南：[Seedream 4.0](https://www.volcengine.com/docs/82379/1829186) 、[Seedream 3.0](https://www.volcengine.com/docs/82379/1795150)）
建议不超过300个汉字或600个英文单词。字数过多信息容易分散，模型可能因此忽略细节，只关注重点，造成图片缺失部分元素。

---


**image** `string/array` 
> doubao\-seedream\-3.0\-t2i 不支持该参数

输入的图片信息，支持 URL 或 Base64 编码。其中，doubao\-seedream\-5.0\-lite/4.5/4.0 支持单图或多图输入（[查看多图融合示例](https://www.volcengine.com/docs/82379/1824121?lang=zh#4a35e28f)），doubao\-seededit\-3.0\-i2i 仅支持单图输入。

* 图片URL：请确保图片URL可被访问。
* Base64编码：请遵循此格式`data:image/<图片格式>;base64,<Base64编码>`。注意 `<图片格式>` 需小写，如 `data:image/png;base64,<base64_image>`。

:::tip

* 传入图片需要满足以下条件：
   * 图片格式：jpeg、png（doubao\-seedream\-5.0\-lite/4.5/4.0 模型新增支持 webp、bmp、tiff、gif 格式**==^new^==**）
   * 宽高比（宽/高）范围：
      * [1/16, 16] (适用模型：doubao\-seedream\-5.0\-lite/4.5/4.0）
      * [1/3, 3] (适用模型：doubao\-seedream\-3.0\-t2i/seededit\-3.0\-i2i）
   * 宽高长度（px） \> 14
   * 大小：不超过 10MB
   * 总像素：不超过 `6000x6000=36000000` px （对单张图宽度和高度的像素乘积限制，而不是对宽度或高度的单独值进行限制）
* doubao\-seedream\-5.0\-lite/4.5/4.0 最多支持传入 14 张参考图。


:::
---


**size **  `string` 

```mixin-react
return (<Tabs>
<Tabs.TabPane title="doubao-seedream-5.0-lite" key="BMB6AP1M"><RenderMd content={`指定生成图像的尺寸信息，支持以下两种方式，不可混用。

* 方式 1 | 指定生成图像的分辨率，并在prompt中用自然语言描述图片宽高比、图片形状或图片用途，最终由模型判断生成图片的大小。
   * 可选值：\`2K\`、\`3K\`
* 方式 2 | 指定生成图像的宽高像素值：
   * 默认值：\`2048x2048\`
   * 总像素取值范围：[\`2560x1440=3686400\`, \`3072x3072x1.1025=10404496\`] 
   * 宽高比取值范围：[1/16, 16]

:::tip
采用方式 2 时，需同时满足总像素取值范围和宽高比取值范围。其中，总像素是对单张图宽度和高度的像素乘积限制，而不是对宽度或高度的单独值进行限制。

* **有效示例**：\`3750x1250\`

总像素值 3750x1250=4687500，符合 [3686400, 10404496] 的区间要求；宽高比 3750/1250=3，符合 [1/16, 16] 的区间要求，故该示例值有效。

* **无效示例**：\`1500x1500\`

总像素值 1500x1500=2250000，未达到 3686400 的最低要求；宽高 1500/1500=1，虽符合 [1/16, 16] 的区间要求，但因其未同时满足两项限制，故该示例值无效。
:::
推荐的宽高像素值：

|分辨率 |宽高比 |宽高像素值 |
|---|---|---|
|<div style="text-align: center">|1:1 |2048x2048 |\\
|2K</div>| | |\\
| | | |
|^^|4:3 |2304x1728 |
|^^|3:4 |1728x2304 |
|^^|16:9 |2848x1600 |
|^^|9:16 |1600x2848 |
|^^|3:2 |2496x1664 |
|^^|2:3 |1664x2496 |
|^^|21:9 |3136x1344 |
|<div style="text-align: center">|1:1 |3072x3072 |\\
|3K</div>| | |\\
| | | |
|^^|4:3 |3456x2592 |
|^^|3:4 |2592x3456 |
|^^|16:9  |4096x2304 |
|^^|9:16 |2304x4096 |
|^^|2:3 |2496x3744 |
|^^|3:2 |3744x2496 |
|^^|21:9 |4704x2016 |


`}></RenderMd></Tabs.TabPane>
<Tabs.TabPane title="doubao-seedream-4.5" key="kghENadO"><RenderMd content={`指定生成图像的尺寸信息，支持以下两种方式，不可混用。

* 方式 1 | 指定生成图像的分辨率，并在prompt中用自然语言描述图片宽高比、图片形状或图片用途，最终由模型判断生成图片的大小。
   * 可选值：\`2K\`、\`4K\`
* 方式 2 | 指定生成图像的宽高像素值：
   * 默认值：\`2048x2048\`
   * 总像素取值范围：[\`2560x1440=3686400\`, \`4096x4096=16777216\`] 
   * 宽高比取值范围：[1/16, 16]

:::tip
采用方式 2 时，需同时满足总像素取值范围和宽高比取值范围。其中，总像素是对单张图宽度和高度的像素乘积限制，而不是对宽度或高度的单独值进行限制。

* **有效示例**：\`3750x1250\`

总像素值 3750x1250=4687500，符合 [3686400, 16777216] 的区间要求；宽高比 3750/1250=3，符合 [1/16, 16] 的区间要求，故该示例值有效。

* **无效示例**：\`1500x1500\`

总像素值 1500x1500=2250000，未达到 3686400 的最低要求；宽高 1500/1500=1，虽符合 [1/16, 16] 的区间要求，但因其未同时满足两项限制，故该示例值无效。
:::
推荐的宽高像素值：

|分辨率 |宽高比 |宽高像素值 |
|---|---|---|
|<div style="text-align: center">|1:1 |2048x2048 |\\
|2K</div>| | |\\
| | | |
|^^|4:3 |2304x1728 |
|^^|3:4 |1728x2304 |
|^^|16:9 |2848x1600 |
|^^|9:16 |1600x2848 |
|^^|3:2 |2496x1664 |
|^^|2:3 |1664x2496 |
|^^|21:9 |3136x1344 |
|<div style="text-align: center">|1:1 |4096x4096 |\\
|4K</div>| | |\\
| | | |
|^^|3:4 |3520x4704 |
|^^|4:3 |4704x3520 |
|^^|16:9 |5504x3040 |
|^^|9:16 |3040x5504 |
|^^|2:3  |3328x4992 |
|^^|3:2  |4992x3328 |
|^^|21:9  |6240x2656 |


`}></RenderMd></Tabs.TabPane>
<Tabs.TabPane title="doubao-seedream-4.0" key="MKsftGMr"><RenderMd content={`指定生成图像的尺寸信息，支持以下两种方式，不可混用。

* 方式 1 | 指定生成图像的分辨率，并在prompt中用自然语言描述图片宽高比、图片形状或图片用途，最终由模型判断生成图片的大小。
   * 可选值：\`1K\`、\`2K\`、\`4K\`
* 方式 2 | 指定生成图像的宽高像素值：
   * 默认值：\`2048x2048\`
   * 总像素取值范围：[\`1280x720=921600\`, \`4096x4096=16777216\`] 
   * 宽高比取值范围：[1/16, 16]

:::tip
采用方式 2 时，需同时满足总像素取值范围和宽高比取值范围。其中，总像素是对单张图宽度和高度的像素乘积限制，而不是对宽度或高度的单独值进行限制。

* **有效示例**：\`1600x600\`

总像素值 1600x600=960000，符合 [921600, 16777216] 的区间要求；宽高比 1600/600=8/3，符合 [1/16, 16] 的区间要求，故该示例值有效。

* **无效示例**：\`800x800\`

总像素值 800x800=640000，未达到 921600 的最低要求；宽高 800/800=1，虽符合 [1/16, 16] 的区间要求，但因其未同时满足两项限制，故该示例值无效。
:::
推荐的宽高像素值：

|分辨率 |宽高比 |宽高像素值 |
|---|---|---|
|<div style="text-align: center">|1:1 |1024x1024 |\\
|1K</div>| | |\\
| | | |
|^^|4:3 |864x1152 |
|^^|3:4 |1152x864 |
|^^|16:9 |1280x720 |
|^^|9:16 |720x1280 |
|^^|3:2 |832x1248  |
|^^|2:3 |1248x832 |
|^^|21:9 |1512x648 |
|<div style="text-align: center">|1:1 |2048x2048 |\\
|2K</div>| | |\\
| | | |
|^^|4:3 |2304x1728 |
|^^|3:4 |1728x2304 |
|^^|16:9 |2848x1600 |
|^^|9:16 |1600x2848 |
|^^|3:2 |2496x1664 |
|^^|2:3 |1664x2496 |
|^^|21:9 |3136x1344 |
|<div style="text-align: center">|1:1 |4096x4096 |\\
|4K</div>| | |\\
| | | |
|^^|3:4 |3520x4704 |
|^^|4:3 |4704x3520 |
|^^|16:9 |5504x3040 |
|^^|9:16 |3040x5504 |
|^^|2:3  |3328x4992 |
|^^|3:2  |4992x3328 |
|^^|21:9  |6240x2656 |


`}></RenderMd></Tabs.TabPane>
<Tabs.TabPane title="doubao-seededit-3.0-t2i" key="dUuqsxPhNL"><RenderMd content={`指定生成图像的宽高像素值。

* 默认值：\`1024x1024\`
* 单张图片像素取值范围： [\`512x512\`, \`2048x2048\`] 

推荐的宽高像素值：

|宽高比 |宽高像素值 |
|---|---|
|1:1 |1024x1024 |
|4:3 |864x1152 |
|3:4 |1152x864 |
|16:9 |1280x720 |
|9:16 |720x1280 |
|3:2 |832x1248  |
|2:3 |1248x832 |
|21:9 |1512x648 |

`}></RenderMd></Tabs.TabPane>
<Tabs.TabPane title="doubao-seedream-3.0-i2i" key="pOay7SY7u2"><RenderMd content={`指定生成图像的宽高像素值。**当前仅支持 adaptive。** 

* adaptive。将您的输入图片尺寸与下表中的尺寸进行对比，选择最接近的，作为输出图片的尺寸。具体而言，会按顺序从可选比例中，选取与原图宽高比**差值最小**的**第一个**，作为生成图片的比例。
* 预设的高宽像素


|宽/高 |宽 |高 |
|---|---|---|
|0.33 |512 |1536 |
|0.35 |544 |1536 |
|0.38 |576 |1536 |
|0.4 |608 |1536 |
|0.42 |640 |1536 |
|0.47 |640 |1376 |
|0.51 |672 |1312 |
|0.55 |704 |1280 |
|0.56 |736 |1312 |
|0.6 |768 |1280 |
|0.63 |768 |1216 |


`}></RenderMd></Tabs.TabPane></Tabs>);
```


---


**seed** `integer`  `默认值 -1`
> 仅 doubao\-seedream\-3.0\-t2i/seededit\-3.0\-i2i 支持该参数

随机数种子，用于控制模型生成内容的随机性。取值范围为 [\-1, 2147483647]。
:::warning

* 相同的请求下，模型收到不同的seed值，如：不指定seed值或令seed取值为\-1（会使用随机数替代）、或手动变更seed值，将生成不同的结果。
* 相同的请求下，模型收到相同的seed值，会生成类似的结果，但不保证完全一致。


:::
---


**sequential_image_generation** `string` `默认值 disabled`
> 仅 doubao\-seedream\-5.0\-lite/4.5/4.0 支持该参数 | [查看组图输出示例](https://www.volcengine.com/docs/82379/1824121?lang=zh#fc9f85e4)

控制是否关闭组图功能。
:::tip
组图：基于您输入的内容，生成的一组内容关联的图片。

:::
* `auto`：自动判断模式，模型会根据用户提供的提示词自主判断是否返回组图以及组图包含的图片数量。
* `disabled`：关闭组图功能，模型只会生成一张图。


---


**sequential_image_generation_options ** `object`
> 仅 doubao\-seedream\-5.0\-lite/4.5/4.0 支持该参数

组图功能的配置。仅当 **sequential_image_generation ** 为 `auto` 时生效。

属性

---


sequential_image_generation_options.**max_images **  ** ** `integer` `默认值 15`
指定本次请求，最多可生成的图片数量。

* 取值范围： [1, 15]

:::tip
实际可生成的图片数量，除受到 **max_images ** 影响外 **，** 还受到输入的参考图数量影响。**输入的参考图数量+最终生成的图片数量≤15张**。

:::

---


**tools==^new^==** ** **  `array of object`
> 仅 doubao\-seedream\-5.0\-lite 支持该参数

配置模型要调用的工具。

属性

---


tools.**type ** `string`  
指定使用的工具类型。

* `web_search`：联网搜索功能。

:::tip

* 开启联网搜索后，模型会根据用户的提示词自主判断是否搜索互联网内容（如商品、天气等），提升生成图片的时效性，但也会增加一定的时延。
* 实际搜索次数可通过字段 usage.tool_usage.**web_search** 查询，如果为 0 表示未搜索。

:::

---


**stream**  `Boolean` `默认值 false`
> 仅 doubao\-seedream\-5.0\-lite/4.5/4.0 支持该参数 | [查看流式输出示例](https://www.volcengine.com/docs/82379/1824121?lang=zh#e5bef0d7)

控制是否开启流式输出模式。

* `false`：非流式输出模式，等待所有图片全部生成结束后再一次性返回所有信息。
* `true`：流式输出模式，即时返回每张图片输出的结果。在生成单图和组图的场景下，流式输出模式均生效。


---


**guidance_scale **  `Float` 
> doubao\-seedream\-3.0\-t2i 默认值 2.5
> doubao\-seededit\-3.0\-i2i 默认值 5.5
> doubao\-seedream\-5.0\-lite/4.5/4.0 不支持

模型输出结果与prompt的一致程度，生成图像的自由度，又称为文本权重；值越大，模型自由度越小，与用户输入的提示词相关性越强。
取值范围：[`1`, `10`] 。

---


**output_format==^new^==**`string` `默认值 jpeg`
> 仅 doubao\-seedream\-5.0\-lite 支持该参数

指定生成图像的文件格式。可选值：

* `png`
* `jpeg`

:::tip
doubao\-seedream\-4.5/4.0、doubao\-seedream\-3.0\-t2i/seededit\-3.0\-i2i 模型生成图像的文件格式默认为 jpeg，不支持自定义设置。

:::
---


**response_format** `string` `默认值 url`
指定生成图像的返回格式。支持以下两种返回方式：

* `url`：返回图片下载链接；**链接在图片生成后24小时内有效，请及时下载图片。** 
* `b64_json`：以 Base64 编码字符串的 JSON 格式返回图像数据。


---


**watermark**  `Boolean` `默认值 true`
是否在生成的图片中添加水印。

* `false`：不添加水印。
* `true`：在图片右下角添加“AI生成”字样的水印标识。


---


**optimize_prompt_options ** `object` 
> 仅 doubao\-seedream\-5.0\-lite/4.5/4.0 支持该参数

提示词优化功能的配置。

属性
optimize_prompt_options.**mode ** `string`  `默认值 standard`
设置提示词优化功能使用的模式。

* `standard`：标准模式，生成内容的质量更高，耗时较长。
* `fast`：快速模式，生成内容的耗时更短，质量一般；doubao\-seedream\-5.0\-lite/4.5 当前不支持。


---


&nbsp;
<span id="7P96iLnc"></span>
## 响应参数
<span id="Hrya4y9k"></span>
### 流式响应参数
请参见[文档](https://www.volcengine.com/docs/82379/1824137?lang=zh)。
&nbsp;
<span id="1AxnwQZN"></span>
### 非流式响应参数

---


**model** `string`
本次请求使用的模型 ID （`模型名称-版本`）。

---


**created** `integer`
本次请求创建时间的 Unix 时间戳（秒）。

---


**data** `array`
输出图像的信息。
:::tip
doubao\-seedream\-5.0\-lite/4.5/4.0 模型生成组图场景下，组图生成过程中某张图生成失败时：

* 若失败原因为审核不通过：仍会继续请求下一个图片生成任务，即不影响同请求内其他图片的生成流程。
* 若失败原因为内部服务异常（500）：不会继续请求下一个图片生成任务。


:::
可能类型
图片信息 `object`
生成成功的图片信息。

属性
data.**url ** `string`
图片的 url 信息，当 **response_format ** 指定为 `url` 时返回。该链接将在生成后 **24 小时内失效**，请务必及时保存图像。

---


data.**b64_json** `string`
图片的 base64 信息，当 **response_format ** 指定为 `b64_json` 时返回。

---


data.**size** `string`
> 仅 doubao\-seedream\-5.0\-lite/4.5/4.0 支持该字段。

图像的宽高像素值，格式 `<宽像素>x<高像素>`，如`2048×2048`。


---


错误信息 `object`
某张图片生成失败，错误信息。

属性
data.**error** `object`
错误信息结构体。

属性

---


data.error.**code**
某张图片生成错误的错误码，请参见[错误码](https://www.volcengine.com/docs/82379/1299023)。

---


data.error.**message**
某张图片生成错误的提示信息。




---


**tools**  `array of object` 
本次请求，配置的模型调用工具

属性

---


tools.**type ** `string` 
配置的调用工具类型。

* web_search：联网搜索工具。


---


**usage** `object`
本次请求的用量信息。

属性

---


usage.**generated_images ** `integer`
模型成功生成的图片张数，不包含生成失败的图片。
仅对成功生成图片按张数进行计费。

---


usage.**output_tokens** `integer`
模型生成的图片花费的 token 数量。
计算逻辑为：计算 `sum(图片长*图片宽)/256` ，然后取整。

---


usage.**total_tokens** `integer`
本次请求消耗的总 token 数量。
当前不计算输入 token，故与 **output_tokens** 值一致。

---


usage.**tool_usage ** `object`
使用工具的用量信息。

属性

---


usage.tool_usage.**web_search ** `integer`
调用联网搜索工具次数，仅开启联网搜索时返回。



---


**error**  `object`
本次请求，如发生错误，对应的错误信息。 

属性

---


error.**code** `string` 
请参见[错误码](https://www.volcengine.com/docs/82379/1299023)。

---


error.**message** `string`
错误提示信息

&nbsp;


