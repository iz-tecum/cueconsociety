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
  return String(body??'').replace(/\r\n?/g,'\n').split(/\n\s*\n/).filter(block=>block.trim()).map(block=>{
    const lines=block.split('\n');
    if(lines.every(line=>/^[-*] /.test(line)))return '<ul style="margin:0 0 20px;padding-left:22px;">'+lines.map(line=>'<li style="margin:0 0 7px;">'+inline(line.slice(2))+'</li>').join('')+'</ul>';
    if(/^#{1,3} /.test(block)&&lines.length===1)return '<h2 style="margin:28px 0 12px;font-family:'+font+';font-size:22px;line-height:1.3;font-weight:700;color:'+navy+';">'+inline(block.replace(/^#{1,3} /,''))+'</h2>';
    return '<p style="margin:0 0 20px;">'+lines.map(inline).join('<br>')+'</p>';
  }).join('\n');
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
    '<div style="display:none;font-size:1px;line-height:1px;color:#f3f6f8;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">'+preheader+'</div>'+
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f3f6f8" style="width:100%;border-collapse:collapse;"><tr><td align="center" style="padding:24px 10px;">'+
    '<table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:640px;border-collapse:collapse;">'+
    '<tr><td bgcolor="'+blue+'" align="center" style="padding:28px 24px 26px;background-color:'+blue+';border-bottom:3px solid '+navy+';">'+
    '<a href="https://cueconsociety.com/" style="text-decoration:none;"><img src="'+logoURL+'" width="54" height="63" alt="Columbia Economics Society" style="display:block;width:54px;height:63px;margin:0 auto 16px;border:0;"></a>'+
    '<div style="font-family:'+font+';font-size:22px;line-height:1.2;font-weight:700;letter-spacing:1px;color:'+navy+';">COLUMBIA ECONOMICS<br>SOCIETY</div></td></tr>'+
    '<tr><td style="padding:32px 28px 20px;font-family:'+font+';font-size:16px;line-height:1.65;color:'+navy+';word-break:break-word;">'+
    '<h1 style="margin:0 0 24px;font-family:'+font+';font-size:30px;line-height:1.2;font-weight:700;color:'+navy+';">'+subject+'</h1>'+renderBodyHTML(draft.body)+'</td></tr>'+
    '<tr><td bgcolor="'+blue+'" style="padding:22px 28px;background-color:'+blue+';border-top:1px solid #b8d3e3;font-family:'+font+';font-size:12px;line-height:1.7;color:'+navy+';">'+
    '<strong>Columbia Economics Society</strong><br>Columbia University<br><a href="https://cueconsociety.com/" style="color:'+navy+';text-decoration:underline;">cueconsociety.com</a>'+recipient+sender+'<br>'+unsubscribeHTML+'</td></tr>'+
    '</table></td></tr></table></body></html>';
}
return {renderEmailHTML,renderBodyHTML};
});
