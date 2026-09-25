/* SPDX-License-Identifier: GPL-2.0 */
static void run_charge_work(struct t6_platform *p)
{
 if(p->charge_work.pending) { p->charge_work.pending=false; t6_charge_work(&p->charge_work.work); }
}
static void *concurrent_write(void *arg)
{
 struct t6_platform *p=arg;
 assert(t6_platform_op_begin(p)==-ENODEV);
 return NULL;
}
int main(void)
{
 struct platform_device pdev={0};
 struct t6_platform p={.pdev=&pdev,.online=true,.fan_manual=true,.fan_pwm={30,40,50},.charge_start=50,.charge_end=70};
 mutex_init(&p.ec_lock);mutex_init(&p.op_lock);mutex_init(&p.fan_lock);mutex_init(&p.led_lock);mutex_init(&p.charge_lock);
 pdev.dev.data=&p;
 registers[0x59]=0x12;
 for(unsigned i=0;i<3;i++) {registers[fan_addresses[i]]=50;observed[i]=50;applied[i]=10;}
 assert(t6_fan_release_control(&p)==0);
 for(unsigned i=0;i<3;i++) assert(applied[i]==50);
 assert(registers[0x59]==0x12);
 mutex_lock(&p.op_lock);p.online=false;
 pthread_t writer;assert(!pthread_create(&writer,NULL,concurrent_write,&p));
 assert(t6_fan_release_control(&p)==0);
 mutex_unlock(&p.op_lock);assert(!pthread_join(writer,NULL));p.online=true;
 assert(t6_write_pwm_enable(&p,0)==0);msleep(2000);
 for(unsigned i=0;i<3;i++) assert(applied[i]==100);
 assert(t6_write_pwm(&p,0,0)==-EBUSY);
 assert(t6_write_pwm_enable(&p,2)==-EINVAL);
 assert(t6_write_pwm_enable(&p,1)==0);msleep(2000);
 for(unsigned i=0;i<3;i++) assert(applied[i]==p.fan_pwm[i]);
 puts("Fan gate-off parking, lifecycle exclusion and PWM0/1 semantics: PASS");
 registers[0x7c]=10;
 fail_read=0x57;
 assert(t6_charge_set_threshold(&p,true,55)==-EIO);
 run_charge_work(&p);
 assert((registers[0x57]&0x60)==0x60);
 assert(t6_charge_set_threshold(&p,true,0)==0);
 fail_write=0x57;
 assert(t6_charge_set_threshold(&p,false,100)==-EIO);
 run_charge_work(&p);
 assert((registers[0x57]&0x60)==0);
 registers[0xa1]=0x09;
 t6_charge_psy_notify(&p.charge_psy_nb,PSY_EVENT_PROP_CHANGED,NULL);
 run_charge_work(&p);
 assert(registers[0xa1]==0x09);
 assert(t6_charge_set_threshold(&p,false,70)==0);
 assert(t6_charge_set_threshold(&p,true,50)==0);
 registers[0x7c]=60;
 assert(t6_charge_suspend(&p)==0);
 assert((registers[0x57]&0x60)==0);
 assert(t6_charge_resume(&p)==0);
 assert((registers[0x57]&0x60)==0x60);
 puts("Charge failure rearm, failed EC handback, inactive LED and PM hysteresis: PASS");
 struct t6_led red={.priv=&p,.address=0x50,.on_value=8,.mode=T6_LED_FULL_BYTE};
 struct t6_led white={.priv=&p,.address=0x50,.on_value=1,.mode=T6_LED_FULL_BYTE};
 assert(t6_led_set_blocking(&red.cdev,1)==0);
 assert(t6_led_set_blocking(&white.cdev,0)==0);
 assert(t6_led_get(&red.cdev)==1 && t6_led_get(&white.cdev)==0);
 assert(t6_led_set_blocking(&white.cdev,1)==0);
 assert(t6_led_get(&red.cdev)==0 && t6_led_get(&white.cdev)==1);
 fail_write=0xa2;
 assert(tray_speed_store(&pdev.dev,NULL,"fast",4)==-EIO);
 assert(p.tray_speed==0);
 assert(tray_speed_store(&pdev.dev,NULL,"fast",4)==4);
 struct t6_led blue={.priv=&p,.address=0xa2,.mask=2,.on_value=2,.is_tray=true,.mode=T6_LED_MASKED};
 assert(t6_led_set_blocking(&blue.cdev,1)==0);
 assert(registers[0xa2]==0xc3);
 puts("LED sibling isolation/readback and transactional tray speed: PASS");
}
