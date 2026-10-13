(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CESNewsletter=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const logoURL='https://admin.cueconsociety.com/admin/assets/ceslogo.png';
const font='Arial, Helvetica, sans-serif';
const navy='#0b1220', blue='#dbf2ff';
const escape=value=>String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
function safeURL(value){
  if(typeof value!=='string'||/[\u0000-\u0020\u007f]/.test(value))return '';
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch{return '';}
}
function inline(text){
  return escape(text).replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,(whole,label,href)=>{
    const url=safeURL(href.replace(/&amp;/g,'&'));
    return url?'<a href="'+escape(url)+'" style="color:#174968;text-decoration:underline;" rel="noreferrer noopener">'+label+'</a>':whole;
  });
}
function renderBodyHTML(body){
  return String(body??'').replace(/\r\n?/g,'\n').split(/\n\s*\n/).filter(block=>block.trim()).map((block,index,blocks)=>{
    const lines=block.split('\n');
    if(block.trim()==='---')return '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;margin:26px 0;"><tr><td height="1" bgcolor="#b8ccd8" style="height:1px;font-size:0;line-height:0;background-color:#b8ccd8;">&nbsp;</td></tr></table>';
    const action=lines.length===1&&block.match(/^\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)$/);
    if(action&&safeURL(action[2]))return '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin:4px 0 24px;"><tr><td bgcolor="'+navy+'" style="padding:13px 20px;background-color:'+navy+';"><a href="'+escape(safeURL(action[2]))+'" style="display:inline-block;font-family:'+font+';font-size:14px;line-height:1.3;font-weight:700;color:#ffffff;text-decoration:none;" rel="noreferrer noopener">'+escape(action[1])+'</a></td></tr></table>';
    if(lines.every(line=>/^> ?/.test(line)))return '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 22px;"><tr><td bgcolor="#edf7fd" style="padding:16px 18px;background-color:#edf7fd;border-left:3px solid '+navy+';font-family:'+font+';font-size:15px;line-height:1.6;color:'+navy+';">'+lines.map(line=>inline(line.replace(/^> ?/,''))).join('<br>')+'</td></tr></table>';
    if(lines.every(line=>/^[-*] /.test(line)))return '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 22px;"><tr><td bgcolor="#f3f8fb" style="padding:17px 18px 10px;background-color:#f3f8fb;font-family:'+font+';font-size:15px;line-height:1.6;"><ul style="margin:0;padding-left:20px;">'+lines.map(line=>'<li style="margin:0 0 7px;">'+inline(line.slice(2))+'</li>').join('')+'</ul></td></tr></table>';
    if(/^#{1,3} /.test(block)&&lines.length===1){const followsDivider=index>0&&blocks[index-1].trim()==='---';return '<h2 style="margin:'+(followsDivider?'0':'24px')+' 0 14px;'+(followsDivider?'':'padding-top:15px;border-top:1px solid #c9dae5;')+'font-family:'+font+';font-size:22px;line-height:1.25;font-weight:700;color:'+navy+';">'+inline(block.replace(/^#{1,3} /,''))+'</h2>';}
    return '<p style="margin:0 0 20px;">'+lines.map(inline).join('<br>')+'</p>';
  }).join('\n');
}
function renderBodyText(body){
  return String(body??'').replace(/\r\n?/g,'\n').split(/\n\s*\n/).filter(block=>block.trim()&&block.trim()!=='---')
    .map(block=>block.replace(/^#{1,3} /gm,'').replace(/^> ?/gm,'').replace(/\*\*([^*\n]+)\*\*/g,'$1').replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,'$1 ($2)')).join('\n\n');
}
function renderEmailHTML(draft={},options={}){
  const subject=escape(draft.subject||'CES newsletter');
  const preheader=escape(draft.preheader||'');
  const unsubscribe=safeURL(options.unsubscribeUrl);
  const recipient=options.recipientEmail?'<br>Sent to '+escape(options.recipientEmail):'';
  const sender=options.fromEmail?'<br>From '+escape(options.fromEmail):'';
  const unsubscribeHTML=unsubscribe?'<a href="'+escape(unsubscribe)+'" style="color:'+navy+';text-decoration:underline;" rel="noreferrer noopener">Unsubscribe</a>':'<span>Unsubscribe</span>';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+subject+'</title></head>'+
    '<body style="margin:0;padding:0;background-color:#f3f6f8;color:'+navy+';font-family:'+font+';">'+
    (preheader?'<div aria-hidden="true" style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">'+preheader+'</div>':'')+
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f3f6f8" style="width:100%;border-collapse:collapse;"><tr><td align="center" style="padding:24px 10px;">'+
    '<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;border-collapse:collapse;">'+
    '<tr><td style="padding:22px 28px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;"><tr>'+
    '<td width="58" valign="middle" style="width:58px;padding-right:14px;"><a href="https://cueconsociety.com/" style="text-decoration:none;"><img src="'+logoURL+'" width="44" height="51" alt="CES" style="display:block;width:44px;height:51px;border:0;"></a></td>'+
    '<td valign="middle" style="font-family:'+font+';font-size:14px;line-height:1.35;font-weight:700;letter-spacing:1px;color:'+navy+';">COLUMBIA<br>ECONOMICS SOCIETY</td></tr></table></td></tr>'+
    '<tr><td height="3" bgcolor="'+navy+'" style="height:3px;font-size:0;line-height:0;background-color:'+navy+';">&nbsp;</td></tr>'+
    '<tr><td height="4" bgcolor="#ffffff" style="height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>'+
    '<tr><td height="1" bgcolor="'+navy+'" style="height:1px;font-size:0;line-height:0;background-color:'+navy+';">&nbsp;</td></tr>'+
    '<tr><td bgcolor="'+blue+'" style="padding:30px 28px 28px;background-color:'+blue+';">'+
    '<h1 style="margin:0;font-family:'+font+';font-size:32px;line-height:1.12;font-weight:700;letter-spacing:-0.5px;color:'+navy+';word-break:break-word;">'+subject+'</h1>'+
    (preheader?'<p style="margin:16px 0 0;font-family:'+font+';font-size:16px;line-height:1.5;color:#26445b;">'+preheader+'</p>':'')+'</td></tr>'+
    '<tr><td style="padding:12px 28px 16px;font-family:'+font+';font-size:16px;line-height:1.65;color:'+navy+';word-break:break-word;">'+renderBodyHTML(draft.body)+'</td></tr>'+
    '<tr><td bgcolor="#f3f8fb" style="padding:22px 28px;background-color:#f3f8fb;border-top:1px solid #b8d3e3;font-family:'+font+';font-size:12px;line-height:1.7;color:'+navy+';">'+
    '<strong>Columbia Economics Society</strong><br>Columbia University<br><a href="https://cueconsociety.com/" style="color:'+navy+';text-decoration:underline;">cueconsociety.com</a>'+recipient+sender+'<br>'+unsubscribeHTML+'</td></tr>'+
    '</table></td></tr></table></body></html>';
}
return {renderEmailHTML,renderBodyHTML,renderBodyText};
});
